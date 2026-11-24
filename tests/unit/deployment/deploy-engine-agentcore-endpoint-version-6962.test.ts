/**
 * go-to-k/cdkd#6962 review: CDK's `runtime.addEndpoint()` passes
 * `Fn::GetAtt [Runtime, AgentRuntimeVersion]`, and every runtime update mints
 * a new version, which CloudFormation moves the endpoint to. The version is
 * not a template property, so only the `IN_PLACE_UPDATE_DERIVED_ATTRS` entry
 * promotes the endpoint; driven through `DeployEngine.deploy` with the REAL
 * `DiffCalculator`, `DagBuilder` and resolver. Under `--no-wait` the promoted
 * endpoint update also waits for the runtime's skipped READY wait (rule 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import { deferReadiness } from '../../../src/provisioning/deferred-readiness.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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
      send: () =>
        Promise.reject(
          Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        ),
    },
    sts: { send: () => Promise.resolve({ Account: '123456789012' }) },
  }),
}));

vi.mock('p-limit', () => ({ default: () => <T>(fn: () => T) => fn() }));

import { awaitRefusalEdgeTarget } from '../../../src/provisioning/deferred-refusal-edges.js';

const STACK = 'agentcore-endpoint-stack';
const REGION = 'us-east-1';
const RUNTIME_ID = 'rt_abc-0123456789';
const RUNTIME = 'AWS::BedrockAgentCore::Runtime';
const ENDPOINT = 'AWS::BedrockAgentCore::RuntimeEndpoint';

const runtimeProps = (phase: string) => ({
  AgentRuntimeName: 'rt',
  RoleArn: 'arn:aws:iam::123456789012:role/rt',
  AgentRuntimeArtifact: { CodeConfiguration: { Runtime: 'PYTHON_3_12', EntryPoint: ['app.py'] } },
  EnvironmentVariables: { PHASE: phase },
});

const template = (phase: string): CloudFormationTemplate => ({
  Resources: {
    Runtime: { Type: RUNTIME, Properties: runtimeProps(phase) },
    Endpoint: {
      Type: ENDPOINT,
      Properties: {
        Name: 'live',
        AgentRuntimeId: { 'Fn::GetAtt': ['Runtime', 'AgentRuntimeId'] },
        AgentRuntimeVersion: { 'Fn::GetAtt': ['Runtime', 'AgentRuntimeVersion'] },
      },
    },
  },
});

function priorState(): StackState {
  const endpointProps = { Name: 'live', AgentRuntimeId: RUNTIME_ID, AgentRuntimeVersion: '1' };
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Runtime: {
        physicalId: RUNTIME_ID,
        resourceType: RUNTIME,
        properties: runtimeProps('1'),
        observedProperties: runtimeProps('1'),
        attributes: { AgentRuntimeId: RUNTIME_ID, AgentRuntimeVersion: '1' },
        dependencies: [],
      },
      Endpoint: {
        physicalId: 'endpoint-arn',
        resourceType: ENDPOINT,
        properties: endpointProps,
        observedProperties: endpointProps,
        attributes: {},
        dependencies: ['Runtime'],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

describe('DeployEngine - a runtime endpoint follows its runtime to the new version', () => {
  let provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  const order: string[] = [];
  let savedNoWait: string | undefined;

  beforeEach(() => {
    order.length = 0;
    savedNoWait = process.env['CDKD_NO_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
    provider = {
      create: vi.fn(),
      update: vi.fn(async (logicalId: string, physicalId: string, type: string, properties: Record<string, unknown>) => {
        if (logicalId === 'Runtime') {
          // UpdateAgentRuntime mints version 2 and, under --no-wait, returns
          // while UPDATING, deferring the READY wait.
          deferReadiness(logicalId, RUNTIME, RUNTIME_ID, async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            order.push('runtime ready');
          });
          return {
            physicalId,
            wasReplaced: false,
            attributes: { AgentRuntimeId: RUNTIME_ID, AgentRuntimeVersion: '2' },
          };
        }
        // The Cloud Control route's rule-3 hook, as cloud-control/update.ts runs it.
        await awaitRefusalEdgeTarget(logicalId, type, properties);
        order.push('endpoint updated');
        return { physicalId, wasReplaced: false };
      }),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(() => Promise.resolve(undefined)),
    };
    stateBackend = {
      getState: vi.fn(() => Promise.resolve({ state: priorState(), etag: 'etag-old' })),
      saveState: vi.fn(() => Promise.resolve('etag-new')),
    };
  });
  afterEach(() => {
    if (savedNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = savedNoWait;
  });

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: () => Promise.resolve(true),
        releaseLock: () => Promise.resolve(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: () => provider,
        getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: () => [],
        validateResourceTypes: () => undefined,
        validateResourceProperties: () => undefined,
      } as never,
      { dryRun: false },
      REGION,
      {
        updateForStack: () => Promise.resolve(undefined),
        prefetch: () => Promise.resolve(undefined),
        lookup: () => Promise.resolve(null),
        patchEntry: () => Promise.resolve(undefined),
      } as never
    );
  }

  const updateCallFor = (logicalId: string): unknown[] | undefined =>
    provider.update.mock.calls.find((c) => c[0] === logicalId);

  it('a runtime update promotes the endpoint, which receives the new version', async () => {
    await makeEngine().deploy(STACK, template('2'));
    expect(updateCallFor('Runtime')).toBeDefined();
    const endpoint = updateCallFor('Endpoint');
    expect(endpoint).toBeDefined();
    expect((endpoint![3] as Record<string, unknown>)['AgentRuntimeVersion']).toBe('2');
  });

  it("--no-wait: the promoted endpoint update waits for the runtime's skipped READY wait", async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await makeEngine().deploy(STACK, template('2'));
    expect(order).toStrictEqual(['runtime ready', 'endpoint updated']);
  });

  it('an unchanged runtime leaves the endpoint alone', async () => {
    await makeEngine().deploy(STACK, template('1'));
    expect(updateCallFor('Runtime')).toBeUndefined();
    expect(updateCallFor('Endpoint')).toBeUndefined();
  });
});
