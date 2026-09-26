/**
 * Two readers the diff used to leave NO_CHANGE although the value they resolve
 * to moves in the deploy, driven through `DeployEngine.deploy` with the REAL
 * `DiffCalculator`, `DagBuilder` and `IntrinsicFunctionResolver`:
 *
 * - go-to-k/cdkd#3722: a `Ref` reader of a custom resource whose handler
 *   answers an Update with a NEW `PhysicalResourceId`. Only a custom resource
 *   can move its physical id in place, so its `Ref` readers are promoted and the
 *   engine decides from the resolved id — skipping the reader when the id did
 *   not move, and replacing a create-only reader only when it did.
 * - go-to-k/cdkd#3717: a nested CHILD's reader of a parameter carrying a
 *   `NoEcho` value the parent supplied in THIS deploy. The child's diff side
 *   binds the redacted parameter, `***` like the record, so it never saw the
 *   change; the engine now tells the calculator which parameters are fresh,
 *   and the fresh mark follows the value into the reader's own bag, or the
 *   no-change skip would read `***` as equal to `***`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { getCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import {
  carriesFreshNoEchoValue,
  recordFreshNoEchoValuesIn,
  recordMaskOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

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
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:h';

type Provider = Record<string, ReturnType<typeof vi.fn>>;

function makeEngine(
  provider: Provider,
  stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> },
  options: Record<string, unknown> = {}
): DeployEngine {
  return new DeployEngine(
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
    { dryRun: false, ...options },
    REGION,
    {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    } as never
  );
}

const callsFor = (fn: ReturnType<typeof vi.fn>, id: string): unknown[][] =>
  fn.mock.calls.filter((c) => c[0] === id);

function savedState(stateBackend: { saveState: ReturnType<typeof vi.fn> }): StackState {
  return stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
}

describe('DeployEngine - a Ref reader of a custom resource whose handler returns a new physical id (go-to-k/cdkd#3722)', () => {
  const STACK = 'cr-ref-stack';

  /** `Reader` reads `{Ref: Cr}` in `readerProp` (a topic: `DisplayName` or create-only `TopicName`). */
  function setup(
    readerProp: 'DisplayName' | 'TopicName',
    displayName = 'd'
  ): {
    template: CloudFormationTemplate;
    stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  } {
    const reader =
      readerProp === 'DisplayName'
        ? { TopicName: 'topic', DisplayName: 'cr-1' }
        : { TopicName: 'cr-1', DisplayName: 'd' };
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      outputs: {},
      lastModified: 0,
      resources: {
        Cr: {
          physicalId: 'cr-1',
          resourceType: 'Custom::Thing',
          properties: { ServiceToken: TOKEN, Seed: 'a' },
          attributes: {},
          dependencies: [],
        },
        Reader: {
          physicalId: 'arn:aws:sns:us-east-1:123456789012:topic',
          resourceType: 'AWS::SNS::Topic',
          properties: reader,
          observedProperties: reader,
          attributes: {},
          dependencies: ['Cr'],
        },
      },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: TOKEN, Seed: 'b' } },
        Reader: {
          Type: 'AWS::SNS::Topic',
          Properties:
            readerProp === 'DisplayName'
              ? { TopicName: 'topic', DisplayName: { Ref: 'Cr' } }
              : { TopicName: { Ref: 'Cr' }, DisplayName: displayName },
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

  function provider(crPhysicalId: string): Provider {
    return {
      create: vi.fn((id: string) => Promise.resolve({ physicalId: `${id}-new` })),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
      update: vi.fn((id: string, physicalId: string) =>
        Promise.resolve(
          id === 'Cr'
            ? { physicalId: crPhysicalId, wasReplaced: crPhysicalId !== physicalId, attributes: {} }
            : { physicalId, wasReplaced: false }
        )
      ),
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it('updates the reader with the new physical id', async () => {
    const { template, stateBackend } = setup('DisplayName');
    const p = provider('cr-2');

    await makeEngine(p, stateBackend).deploy(STACK, template);

    const updates = callsFor(p.update, 'Reader');
    expect(updates).toHaveLength(1);
    // (logicalId, physicalId, resourceType, properties, previousProperties)
    expect((updates[0]![3] as Record<string, unknown>)['DisplayName']).toBe('cr-2');
    expect(savedState(stateBackend).resources['Reader']?.properties['DisplayName']).toBe('cr-2');
  });

  it('skips the reader when the handler kept its physical id (the control)', async () => {
    const { template, stateBackend } = setup('DisplayName');
    const p = provider('cr-1');

    await makeEngine(p, stateBackend).deploy(STACK, template);

    expect(callsFor(p.update, 'Cr')).toHaveLength(1);
    expect(callsFor(p.update, 'Reader')).toHaveLength(0);
  });

  it('updates a create-only reader IN PLACE when another property changed and the id did not move', async () => {
    // The replacement is a ceiling (go-to-k/cdkd#3662): a same-deploy edit
    // elsewhere on the reader must not turn an unmoved id into a destroy and
    // re-create.
    const { template, stateBackend } = setup('TopicName', 'd2');
    const p = provider('cr-1');

    await makeEngine(p, stateBackend).deploy(STACK, template);

    const updates = callsFor(p.update, 'Reader');
    expect(updates).toHaveLength(1);
    expect((updates[0]![3] as Record<string, unknown>)['DisplayName']).toBe('d2');
    expect(callsFor(p.create, 'Reader')).toHaveLength(0);
    expect(callsFor(p.delete, 'Reader')).toHaveLength(0);
  });

  it('replaces a create-only reader when the id moved and another property changed too', async () => {
    const { template, stateBackend } = setup('TopicName', 'd2');
    const p = provider('cr-2');

    await makeEngine(p, stateBackend).deploy(STACK, template);

    const creates = callsFor(p.create, 'Reader');
    expect(creates).toHaveLength(1);
    expect(creates[0]![2]).toMatchObject({ TopicName: 'cr-2', DisplayName: 'd2' });
  });

  it('replaces a reader holding the id in a create-only property only when the id moved', async () => {
    const moved = setup('TopicName');
    const movedProvider = provider('cr-2');
    await makeEngine(movedProvider, moved.stateBackend).deploy(STACK, moved.template);
    const creates = callsFor(movedProvider.create, 'Reader');
    expect(creates).toHaveLength(1);
    expect((creates[0]![2] as Record<string, unknown>)['TopicName']).toBe('cr-2');

    const kept = setup('TopicName');
    const keptProvider = provider('cr-1');
    await makeEngine(keptProvider, kept.stateBackend).deploy(STACK, kept.template);
    expect(callsFor(keptProvider.create, 'Reader')).toHaveLength(0);
    expect(callsFor(keptProvider.delete, 'Reader')).toHaveLength(0);
  });
});

describe('DeployEngine - the PARENT half of go-to-k/cdkd#3717: the stack row hands a fresh bag down', () => {
  // `NestedStackProvider.runChildDeploy` passes `getCurrentResourceSecrets()`
  // to the child engine as `inheritedSecrets`. This pins that the bag bound
  // around the parent's `AWS::CloudFormation::Stack` UPDATE carries the fresh
  // mark for a `NoEcho` value its `Parameters` read this deploy — the input
  // the child test below starts from.
  const STACK = 'param-parent';
  const V2 = 'noecho-token-value-v2';

  it('binds a bag in which the re-minted parameter value is FRESH around the stack row update', async () => {
    const child = { TemplateURL: 'https://s3.amazonaws.com/assets/child.json', Parameters: { Token: '***' } };
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      outputs: {},
      lastModified: 0,
      resources: {
        Cr: {
          physicalId: 'cr-1',
          resourceType: 'Custom::Thing',
          properties: { ServiceToken: TOKEN, Seed: 'a' },
          attributes: { Value: '***' },
          dependencies: [],
        },
        Child: {
          physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/param-parent/Child',
          resourceType: 'AWS::CloudFormation::Stack',
          properties: child,
          observedProperties: child,
          attributes: {},
          dependencies: ['Cr'],
        },
      },
    };
    let freshInBoundBag: boolean | undefined;
    let sentToken: unknown;
    const p: Provider = {
      create: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
      update: vi.fn((id: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
        if (id === 'Cr') {
          return Promise.resolve({
            physicalId,
            wasReplaced: false,
            attributes: { Value: V2 },
            noEchoAttributes: true,
          });
        }
        sentToken = (props['Parameters'] as Record<string, unknown>)['Token'];
        const bound = getCurrentResourceSecrets();
        freshInBoundBag = bound !== undefined && carriesFreshNoEchoValue(sentToken, bound);
        return Promise.resolve({ physicalId, wasReplaced: false });
      }),
    };
    const stateBackend = {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e' }),
      saveState: vi.fn().mockResolvedValue('e2'),
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: TOKEN, Seed: 'b' } },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            TemplateURL: 'https://s3.amazonaws.com/assets/child.json',
            Parameters: { Token: { 'Fn::GetAtt': ['Cr', 'Value'] } },
          },
        },
      },
    };

    await makeEngine(p, stateBackend).deploy(STACK, template);

    // The row was promoted (it reads the updated CR) and sent the new value...
    expect(sentToken).toBe(V2);
    // ...inside a bag that marks it fresh, which is what the child inherits.
    expect(freshInBoundBag).toBe(true);
    expect(JSON.stringify(savedState(stateBackend))).not.toContain(V2);
  });
});

describe('DeployEngine - a nested child reader of a NoEcho parameter the parent re-minted (go-to-k/cdkd#3717)', () => {
  const STACK = 'Parent~Child';
  const V2 = 'noecho-token-value-v2';

  /** The child engine as `NestedStackProvider.runChildDeploy` builds it. */
  function run(inherited: RecordedSecretValues): Promise<{
    provider: Provider;
    stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  }> {
    const reader = { Name: '/app/p', Type: 'String', Value: '***' };
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      outputs: {},
      lastModified: 0,
      resources: {
        Reader: {
          physicalId: '/app/p',
          resourceType: 'AWS::SSM::Parameter',
          properties: reader,
          observedProperties: reader,
          attributes: {},
          dependencies: [],
        },
      },
    };
    const p: Provider = {
      create: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
      update: vi.fn((_id: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
    };
    const stateBackend = {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e' }),
      saveState: vi.fn().mockResolvedValue('e2'),
    };
    const template = {
      Parameters: { Token: { Type: 'String' } },
      Resources: {
        Reader: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/p', Type: 'String', Value: { Ref: 'Token' } },
        },
      },
    } as unknown as CloudFormationTemplate;
    return makeEngine(p, stateBackend, {
      parameters: { Token: V2 },
      inheritedSecrets: inherited,
    })
      .deploy(STACK, template)
      .then(() => ({ provider: p, stateBackend }));
  }

  beforeEach(() => vi.clearAllMocks());

  it('sends the re-minted value to the reader while its record keeps the mask', async () => {
    const inherited: RecordedSecretValues = new Map();
    recordFreshNoEchoValuesIn(V2, inherited);

    const { provider, stateBackend } = await run(inherited);

    const updates = callsFor(provider.update, 'Reader');
    expect(updates).toHaveLength(1);
    expect((updates[0]![3] as Record<string, unknown>)['Value']).toBe(V2);
    const saved = savedState(stateBackend);
    expect(saved.resources['Reader']?.properties['Value']).toBe('***');
    expect(JSON.stringify(saved)).not.toContain(V2);
  });

  it('leaves the reader alone when the parameter is masked but NOT fresh (the control)', async () => {
    // Mask-only without the fresh mark: a value the parent did not supply in
    // this deploy, which is exactly what the record already describes.
    const inherited: RecordedSecretValues = new Map();
    recordMaskOnlyValue(inherited, V2);

    const { provider } = await run(inherited);

    expect(callsFor(provider.update, 'Reader')).toHaveLength(0);
  });
});

/**
 * go-to-k/cdkd#3729 on the #3717 path: the child reader holds the re-minted
 * parameter in a CREATE-ONLY property. Its record is `***`, so the child engine
 * reads the reader back from AWS and replaces it only when AWS holds a
 * different value.
 */
describe('DeployEngine - a nested child create-only reader of a NoEcho parameter (go-to-k/cdkd#3729)', () => {
  const STACK = 'Parent~Child';
  const V2 = 'noecho-token-value-v2';

  function run(live: Record<string, unknown>): Promise<Provider> {
    const reader = { TopicName: '***', DisplayName: 'd1' };
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      outputs: {},
      lastModified: 0,
      resources: {
        Reader: {
          physicalId: 'arn:aws:sns:us-east-1:123456789012:t',
          resourceType: 'AWS::SNS::Topic',
          properties: reader,
          observedProperties: reader,
          attributes: {},
          dependencies: [],
        },
      },
    };
    const p: Provider = {
      create: vi.fn((logicalId: string) => Promise.resolve({ physicalId: `${logicalId}-new` })),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(live),
      update: vi.fn((_id: string, physicalId: string) =>
        Promise.resolve({ physicalId, wasReplaced: false })
      ),
    };
    const stateBackend = {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e' }),
      saveState: vi.fn().mockResolvedValue('e2'),
    };
    const template = {
      Parameters: { Token: { Type: 'String' } },
      Resources: {
        Reader: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: { Ref: 'Token' }, DisplayName: 'd2' },
        },
      },
    } as unknown as CloudFormationTemplate;
    const inherited: RecordedSecretValues = new Map();
    recordFreshNoEchoValuesIn(V2, inherited);
    return makeEngine(p, stateBackend, {
      parameters: { Token: V2 },
      inheritedSecrets: inherited,
      captureObservedState: false,
    })
      .deploy(STACK, template)
      .then(() => p);
  }

  beforeEach(() => vi.clearAllMocks());

  it('updates the reader in place when AWS already holds the re-minted value', async () => {
    const provider = await run({ TopicName: V2, DisplayName: 'd1' });

    expect(provider.readCurrentState).toHaveBeenCalledTimes(1);
    expect((provider.readCurrentState.mock.calls[0]![3] as Record<string, unknown>)['TopicName']).toBe(
      '***'
    );
    expect(callsFor(provider.update, 'Reader')).toHaveLength(1);
    expect(callsFor(provider.create, 'Reader')).toHaveLength(0);
  });

  it('replaces the reader when AWS holds a different value (the control)', async () => {
    const provider = await run({ TopicName: 'noecho-token-value-v1', DisplayName: 'd1' });

    const creates = callsFor(provider.create, 'Reader');
    expect(creates).toHaveLength(1);
    expect((creates[0]![2] as Record<string, unknown>)['TopicName']).toBe(V2);
    expect(callsFor(provider.update, 'Reader')).toHaveLength(0);
  });
});
