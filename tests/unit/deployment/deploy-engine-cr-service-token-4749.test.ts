/**
 * go-to-k/cdkd#4749: a custom resource's changed `ServiceToken` is refused, as
 * CloudFormation refuses it, before any handler is invoked. Driven through
 * `DeployEngine.deploy` with the REAL `DiffCalculator`, `DagBuilder` and
 * `IntrinsicFunctionResolver`, so the plan-time and provisioning-time checks
 * see the rows the real diff builds.
 *
 * Both polarities throughout: a guard refusing every custom-resource update
 * would pass every refusal case, which the unchanged-token cases refuse.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { SERVICE_TOKEN_CHANGE_REFUSED } from '../../../src/deployment/custom-resource-service-token.js';

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
const STACK = 'cr-token-stack';
const OLD_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:old-handler';
const NEW_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:new-handler';

type Provider = Record<string, ReturnType<typeof vi.fn>>;
type Backend = { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };

function makeEngine(provider: Provider, stateBackend: Backend, options: Record<string, unknown> = {}) {
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
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
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

function provider(): Provider {
  return {
    create: vi.fn((id: string, _type: string, props: Record<string, unknown>) =>
      Promise.resolve(
        id === 'Fn'
          ? {
              physicalId: String(props['FunctionName']),
              attributes: {
                Arn: `arn:aws:lambda:us-east-1:123456789012:function:${String(props['FunctionName'])}`,
              },
            }
          : { physicalId: `${id}-new`, attributes: {} }
      )
    ),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
    update: vi.fn((_id: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false, attributes: {} })
    ),
  };
}

const callsFor = (fn: ReturnType<typeof vi.fn>, id: string): unknown[][] =>
  fn.mock.calls.filter((c) => c[0] === id);

function cr(token: unknown, seed = 'a'): ResourceState {
  return {
    physicalId: 'cr-1',
    resourceType: 'Custom::Thing',
    properties: { ServiceToken: token, Seed: seed },
    attributes: {},
    dependencies: [],
  } as ResourceState;
}

function lambda(name: string): ResourceState {
  return {
    physicalId: name,
    resourceType: 'AWS::Lambda::Function',
    properties: { FunctionName: name, Role: 'arn:aws:iam::123456789012:role/r' },
    attributes: { Arn: `arn:aws:lambda:us-east-1:123456789012:function:${name}` },
    dependencies: [],
  } as ResourceState;
}

function backend(resources: Record<string, ResourceState>): Backend {
  const state: StackState = {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    outputs: {},
    lastModified: 0,
    resources,
  };
  return {
    getState: vi.fn().mockResolvedValue({ state: structuredClone(state), etag: 'e' }),
    saveState: vi.fn().mockResolvedValue('e2'),
  };
}

async function deployError(
  engine: DeployEngine,
  template: CloudFormationTemplate
): Promise<Error & { code?: string }> {
  try {
    await engine.deploy(STACK, template);
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('deploy resolved; expected a refusal');
}

/** Every error in the cause chain, so a wrapped refusal is still found. */
function chain(error: unknown): Array<Error & { code?: string }> {
  const out: Array<Error & { code?: string }> = [];
  let node: unknown = error;
  for (let i = 0; i < 10 && node instanceof Error; i++) {
    out.push(node as Error & { code?: string });
    node = (node as { cause?: unknown }).cause;
  }
  return out;
}

beforeEach(() => vi.clearAllMocks());

describe('DeployEngine - a literal ServiceToken change (go-to-k/cdkd#4749)', () => {
  const template = (token: string, seed = 'a'): CloudFormationTemplate => ({
    Resources: { Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: token, Seed: seed } } },
  });

  it('refuses before any provider call, naming the id and the remedy, and saves nothing', async () => {
    const p = provider();
    const stateBackend = backend({ Cr: cr(OLD_TOKEN) });

    const error = await deployError(makeEngine(p, stateBackend), template(NEW_TOKEN, 'b'));

    expect(error.code).toBe(SERVICE_TOKEN_CHANGE_REFUSED);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error.message).toContain(`Cr: ServiceToken changes from ${OLD_TOKEN} to ${NEW_TOKEN}.`);
    expect(error.message).toContain('Modifying service token is not allowed');
    expect(error.message).toContain('give it a new logical id');
    expect(error.message).toContain('overrideLogicalId');
    for (const fn of [p.create, p.update, p.delete]) expect(fn).not.toHaveBeenCalled();
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it('refuses a --dry-run too, rather than previewing a plan it will not run', async () => {
    const p = provider();
    const error = await deployError(
      makeEngine(p, backend({ Cr: cr(OLD_TOKEN) }), { dryRun: true }),
      template(NEW_TOKEN)
    );
    expect(error.code).toBe(SERVICE_TOKEN_CHANGE_REFUSED);
  });

  it('updates in place when only another property changed (the control)', async () => {
    const p = provider();
    await makeEngine(p, backend({ Cr: cr(OLD_TOKEN) })).deploy(STACK, template(OLD_TOKEN, 'b'));
    const updates = callsFor(p.update, 'Cr');
    expect(updates).toHaveLength(1);
    expect((updates[0]![3] as Record<string, unknown>)['ServiceToken']).toBe(OLD_TOKEN);
  });

  it('does not refuse a --recreate-via-cc-api target: it deletes through the old handler and creates through the new', async () => {
    const p = provider();
    await makeEngine(p, backend({ Cr: cr(OLD_TOKEN) }), {
      recreateTargets: { stackName: STACK, viaCcApi: new Set(['Cr']), viaSdkProvider: new Set() },
    }).deploy(STACK, template(NEW_TOKEN));
    expect(callsFor(p.update, 'Cr')).toHaveLength(0);
    const deletes = callsFor(p.delete, 'Cr');
    expect(deletes).toHaveLength(1);
    expect((deletes[0]![3] as Record<string, unknown>)['ServiceToken']).toBe(OLD_TOKEN);
    const creates = callsFor(p.create, 'Cr');
    expect(creates).toHaveLength(1);
    expect((creates[0]![2] as Record<string, unknown>)['ServiceToken']).toBe(NEW_TOKEN);
  });
});

describe('DeployEngine - a ServiceToken that reads the backing Lambda (go-to-k/cdkd#4749)', () => {
  const template = (functionName: string, seed = 'a'): CloudFormationTemplate => ({
    Resources: {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: { FunctionName: functionName, Role: 'arn:aws:iam::123456789012:role/r' },
      },
      Cr: {
        Type: 'Custom::Thing',
        Properties: { ServiceToken: { 'Fn::GetAtt': ['Fn', 'Arn'] }, Seed: seed },
        DependsOn: ['Fn'],
      },
    },
  });

  it('stays a no-op when the Lambda ARN did not change', async () => {
    const p = provider();
    await makeEngine(p, backend({ Fn: lambda('old-handler'), Cr: cr(OLD_TOKEN) })).deploy(
      STACK,
      template('old-handler')
    );
    for (const fn of [p.create, p.update, p.delete]) expect(fn).not.toHaveBeenCalled();
  });

  it('updates in place when the ARN did not change and another property did', async () => {
    const p = provider();
    await makeEngine(p, backend({ Fn: lambda('old-handler'), Cr: cr(OLD_TOKEN) })).deploy(
      STACK,
      template('old-handler', 'b')
    );
    expect(callsFor(p.update, 'Cr')).toHaveLength(1);
  });

  it('refuses the update once the replaced Lambda resolves to a new ARN, invoking no handler', async () => {
    const p = provider();
    const error = await deployError(
      makeEngine(p, backend({ Fn: lambda('old-handler'), Cr: cr(OLD_TOKEN) })),
      template('new-handler')
    );
    // PREMISE: the Lambda was replaced, so the refusal is the provisioning-time one.
    expect(callsFor(p.create, 'Fn').length).toBeGreaterThan(0);
    const refusal = chain(error).find((e) => e.code === SERVICE_TOKEN_CHANGE_REFUSED);
    expect(refusal?.message).toContain(`Cr: ServiceToken changes from ${OLD_TOKEN} to ${NEW_TOKEN}.`);
    for (const fn of [p.create, p.update, p.delete]) expect(callsFor(fn, 'Cr')).toHaveLength(0);
  });
});

describe('DeployEngine - a recorded ServiceToken cdkd cannot compare (go-to-k/cdkd#4749)', () => {
  it('refuses a change over a recorded redaction mask, naming why', async () => {
    const p = provider();
    const error = await deployError(makeEngine(p, backend({ Cr: cr('***') })), {
      Resources: { Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: NEW_TOKEN, Seed: 'a' } } },
    });
    expect(error.code).toBe(SERVICE_TOKEN_CHANGE_REFUSED);
    expect(error.message).toContain("its recorded ServiceToken is the redaction mask '***'");
    expect(error.message).toContain('back as ServiceToken in state.json');
    for (const fn of [p.create, p.update, p.delete]) expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a change over a record holding no ServiceToken', async () => {
    const p = provider();
    const record = cr(OLD_TOKEN);
    delete (record.properties as Record<string, unknown>)['ServiceToken'];
    const error = await deployError(makeEngine(p, backend({ Cr: record })), {
      Resources: { Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: NEW_TOKEN, Seed: 'a' } } },
    });
    expect(error.code).toBe(SERVICE_TOKEN_CHANGE_REFUSED);
    expect(error.message).toContain('its recorded ServiceToken is missing');
    expect(p.update).not.toHaveBeenCalled();
  });
});
