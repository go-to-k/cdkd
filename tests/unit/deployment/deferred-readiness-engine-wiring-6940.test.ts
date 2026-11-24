import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6940 review (T1): the engine wiring of deferred readiness.
 * `provisionCreateUpdateNode` binds a scope around the provider call and
 * keeps what it deferred only when the operation succeeds; and the resolver
 * context's adapters reach the deploy's run and its healer.
 */

const mocks = vi.hoisted(() => ({ provisionResource: vi.fn() }));

vi.mock('../../../src/utils/logger.js', () => {
  const child: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  child['child'] = () => child;
  return { getLogger: () => child };
});
vi.mock('../../../src/deployment/deploy-engine/provision.js', () => ({
  provisionResource: (...args: unknown[]) => mocks.provisionResource(...args),
}));
vi.mock('../../../src/deployment/deploy-engine/signal-receiver-run.js', () => ({
  awaitCreationSignals: async () => undefined,
  refuseUnservedSignalWait: () => undefined,
}));

import { provisionCreateUpdateNode } from '../../../src/deployment/deploy-engine/execute/provision-node.js';
import type { DeployRun } from '../../../src/deployment/deploy-engine/execute/run.js';
import { DeferredReadinessRun } from '../../../src/deployment/deferred-readiness-run.js';
import { DagExecutor } from '../../../src/deployment/dag-executor.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import {
  awaitDeferredResource,
  awaitUpstreamReadiness,
  deferReadiness,
  withDeferredReadinessScope,
} from '../../../src/provisioning/deferred-readiness.js';
import {
  buildResolverContext,
  type ResolverContextDeps,
} from '../../../src/deployment/deploy-engine/resolver-context.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

const TYPE = 'AWS::EC2::NatGateway';

function runFor(readiness: DeferredReadinessRun): DeployRun {
  // Every `replacementRun` collection reads as empty.
  const replacementRun = new Proxy(
    {},
    { get: () => new Map() }
  ) as unknown as DeployRun['engine']['replacementRun'];
  const engine = {
    deferredReadiness: readiness,
    dagBuilder: new DagBuilder(),
    secretsRun: { perResourceSecrets: new Map(), secretNameNeedles: new Map() },
    logger: { info: () => undefined, debug: () => undefined },
    replacementRun,
    attemptedResolvedProps: new Map(),
    resolvedUpdatePolicies: new Map(),
    options: {},
    interrupted: false,
  };
  const template = { Resources: { Nat: { Type: TYPE, Properties: {} } } };
  return {
    engine,
    template,
    dag: new DagBuilder().buildGraph(template as never),
    currentState: { resources: {} },
    stackName: 'App',
    newResources: {},
    actualCounts: {},
    completedOperations: [],
    failedOperations: [],
    reportedCreatesToSettle: [],
    phaseScope: undefined,
    saveStateAfterResource: () => undefined,
    startedUpdates: new Set(),
    settledUpdates: new Set(),
    inFlightWrites: new Map(),
    inFlightCreatedSinks: new Map(),
  } as unknown as DeployRun;
}

const change = { changeType: 'CREATE', resourceType: TYPE } as unknown as ResourceChange;

function readiness(): DeferredReadinessRun {
  return new DeferredReadinessRun({
    logger: { info: vi.fn(), debug: vi.fn() },
    region: 'us-east-1',
    budget: () => ({ warnAfterMs: 1_000, timeoutMs: 2_000 }),
    interrupted: () => false,
  });
}

describe('provisionCreateUpdateNode keeps a deferred wait only on success (#6940)', () => {
  beforeEach(() => {
    mocks.provisionResource.mockReset();
  });

  it('a succeeded create that deferred a wait is recorded', async () => {
    mocks.provisionResource.mockImplementation(async () => {
      deferReadiness('Nat', TYPE, 'nat-1', async () => undefined);
    });
    const run = readiness();
    await provisionCreateUpdateNode(runFor(run), new DagExecutor(), () => undefined, {
      id: 'Nat',
      data: change,
    });
    expect(run.isDeferred('Nat')).toBe(true);
    expect(run.logicalIdOf('nat-1')).toBe('Nat');
  });

  it('a create that deferred a wait and then failed records nothing', async () => {
    mocks.provisionResource.mockImplementation(async () => {
      deferReadiness('Nat', TYPE, 'nat-1', async () => undefined);
      throw new Error('tagging failed');
    });
    const run = readiness();
    await expect(
      provisionCreateUpdateNode(runFor(run), new DagExecutor(), () => undefined, {
        id: 'Nat',
        data: change,
      })
    ).rejects.toThrow('tagging failed');
    expect(run.isDeferred('Nat')).toBe(false);
  });

  it('a create that deferred nothing records nothing', async () => {
    mocks.provisionResource.mockImplementation(async () => undefined);
    const run = readiness();
    await provisionCreateUpdateNode(runFor(run), new DagExecutor(), () => undefined, {
      id: 'Nat',
      data: change,
    });
    expect(run.isEmpty).toBe(true);
  });
});

describe('a nested stack child custom resource also waits for its parent row upstream (#6940 N1)', () => {
  beforeEach(() => {
    mocks.provisionResource.mockReset();
  });

  it("asks the parent row's scope after its own engine's walk", async () => {
    const parentUpstream = vi.fn(async () => undefined);
    mocks.provisionResource.mockImplementation(async () => {
      await awaitUpstreamReadiness('Seed');
    });
    const run = readiness();
    await withDeferredReadinessScope(
      {
        logicalId: 'ChildStack',
        resourceType: 'AWS::CloudFormation::Stack',
        deferred: new Map(),
        awaitUpstreamReadiness: async () => undefined,
        awaitUpstreamReadinessRaw: parentUpstream,
        awaitDeferredResource: () => undefined,
      },
      () =>
        provisionCreateUpdateNode(runFor(run), new DagExecutor(), () => undefined, {
          id: 'Seed',
          data: { changeType: 'CREATE', resourceType: 'Custom::Seed' } as unknown as ResourceChange,
        })
    );
    expect(parentUpstream).toHaveBeenCalledTimes(1);
  });
});

describe('the scope looks a deferred resource up by its physical id (#6940 rule 3)', () => {
  beforeEach(() => {
    mocks.provisionResource.mockReset();
  });

  it("awaitDeferredResource reaches the owning resource's shared wait through the engine", async () => {
    const run = readiness();
    const wait = vi.fn(async () => undefined);
    run.record('Host', 'AWS::EC2::Instance', 'CREATE', new Map([['i-1', { wait, inContext: (fn) => fn() }]]));
    let unknown: Promise<void> | undefined = Promise.resolve();
    mocks.provisionResource.mockImplementation(async () => {
      await awaitDeferredResource('Eip', 'AWS::EC2::EIP', 'i-1', 'Elastic IP Eip is associated with it');
      unknown = awaitDeferredResource('Eip', 'AWS::EC2::EIP', 'i-other', 'x');
    });
    await provisionCreateUpdateNode(runFor(run), new DagExecutor(), () => undefined, {
      id: 'Eip',
      data: { changeType: 'CREATE', resourceType: 'AWS::EC2::EIP' } as unknown as ResourceChange,
    });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(unknown).toBeUndefined();
  });
});

describe('buildResolverContext deferred-readiness adapters (#6940)', () => {
  it('awaitReady reaches the run, readAfterReady the healer with the stack name', async () => {
    const awaitReady = vi.fn(() => Promise.resolve());
    const readAfterReadiness = vi.fn(async () => ({ kind: 'not-attempted' as const }));
    const deps = {
      options: {},
      stateBackend: {},
      resolver: { resolve: vi.fn() },
      secretsRun: () => ({}),
      noEchoRun: () => ({}),
      healBaseline: () => ({}),
      attributeHealer: () => ({ heal: vi.fn(), readAfterReadiness }),
      deferredReadiness: () => ({ awaitReady }),
      recordedImports: () => [],
      recordedOutputReads: () => [],
      runProducerRegionEvidence: () => undefined,
      runStackIdTail: () => undefined,
      signalReceiverStackId: () => undefined,
    } as unknown as ResolverContextDeps;
    const context = buildResolverContext(deps, { template: { Resources: {} }, resources: {} }, 'App');
    await context.deferredReadiness!.awaitReady('Db', 'needed');
    expect(awaitReady).toHaveBeenCalledWith('Db', 'needed');
    const record = { physicalId: 'mydb' } as ResourceState;
    await context.deferredReadiness!.readAfterReady('Db', record);
    expect(readAfterReadiness).toHaveBeenCalledWith('Db', record, 'App');
  });

  it('a deps bag without deferred readiness (another command) adds no adapter', () => {
    const deps = {
      options: {},
      stateBackend: {},
      resolver: { resolve: vi.fn() },
      secretsRun: () => ({}),
      noEchoRun: () => ({}),
      healBaseline: () => ({}),
      attributeHealer: () => ({ heal: vi.fn() }),
      recordedImports: () => [],
      recordedOutputReads: () => [],
      runProducerRegionEvidence: () => undefined,
      runStackIdTail: () => undefined,
      signalReceiverStackId: () => undefined,
    } as unknown as ResolverContextDeps;
    const context = buildResolverContext(deps, { template: { Resources: {} }, resources: {} }, 'App');
    expect(context.deferredReadiness).toBeUndefined();
  });
});
