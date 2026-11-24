import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6940 review round 2:
 * - a CDK-defensive DependsOn edge `--aggressive-vpc-parallel` would relax is
 *   kept when its dependent is upstream of a custom resource or nested stack,
 *   so the executor orders the invoke after the route in every mode, and under
 *   --no-wait the upstream walk reaches the NAT gateway behind it;
 * - a nested child's custom resource chains to its parent row AFTER its own
 *   walk, and a parent failure is re-anchored on the child resource.
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
  awaitUpstreamReadiness,
  deferReadiness,
  withDeferredReadinessScope,
} from '../../../src/provisioning/deferred-readiness.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

// The CDK shape of a VPC Lambda behind a NAT gateway backing a custom
// resource: the function's only path to the NAT gateway is its defensive
// DependsOn on the private subnet's default route, which cdkd relaxes.
const VPC_CR: CloudFormationTemplate = {
  Resources: {
    Nat: { Type: 'AWS::EC2::NatGateway', Properties: {} },
    Route: { Type: 'AWS::EC2::Route', Properties: { NatGatewayId: { Ref: 'Nat' } } },
    Fn: { Type: 'AWS::Lambda::Function', DependsOn: ['Route'], Properties: {} },
    Probe: {
      Type: 'AWS::CloudFormation::CustomResource',
      Properties: { ServiceToken: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
    },
  },
};

function readiness(): DeferredReadinessRun {
  return new DeferredReadinessRun({
    logger: { info: vi.fn(), debug: vi.fn() },
    region: 'us-east-1',
    budget: () => ({ warnAfterMs: 1_000_000, timeoutMs: 2_000_000 }),
    interrupted: () => false,
  });
}

function runFor(template: CloudFormationTemplate, run: DeferredReadinessRun): DeployRun {
  const dagBuilder = new DagBuilder({ relaxCdkVpcDefensiveDeps: true });
  const replacementRun = new Proxy({}, { get: () => new Map() });
  return {
    engine: {
      deferredReadiness: run,
      dagBuilder,
      replacementRun,
      secretsRun: { perResourceSecrets: new Map(), secretNameNeedles: new Map() },
      logger: { info: () => undefined, debug: () => undefined },
      attemptedResolvedProps: new Map(),
      resolvedUpdatePolicies: new Map(),
      options: {},
      interrupted: false,
    },
    template,
    dag: dagBuilder.buildGraph(template),
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run the create phase of `template`: the route takes 40 ms, the rest is instant. */
async function deploy(
  run: DeployRun,
  order: string[],
  concurrency: number,
  natDefers?: () => Promise<void>
): Promise<void> {
  const executor = new DagExecutor<ResourceChange>();
  const deps = (id: string): Set<string> =>
    new Set(run.engine.dagBuilder.getDirectDependencies(run.dag, id));
  for (const id of Object.keys(run.template.Resources ?? {})) {
    executor.add({
      id,
      dependencies: deps(id),
      state: 'pending',
      data: {
        changeType: 'CREATE',
        resourceType: run.template.Resources![id]!.Type,
      } as ResourceChange,
    });
  }
  mocks.provisionResource.mockImplementation(async (_engine: unknown, logicalId: string) => {
    if (logicalId === 'Nat' && natDefers !== undefined) {
      // The NAT provider under --no-wait: returns pending, defers `available`.
      deferReadiness('Nat', 'AWS::EC2::NatGateway', 'nat-1', natDefers);
      order.push('Nat provisioned');
    } else if (logicalId === 'Route') {
      await sleep(40);
      order.push('route provisioned');
    } else if (logicalId === 'Probe') {
      await awaitUpstreamReadiness('Probe');
      order.push('probe invoked');
    } else {
      order.push(`${logicalId} provisioned`);
    }
  });
  await executor.execute(concurrency, (node) =>
    provisionCreateUpdateNode(run, executor, () => undefined, node)
  );
}

const graphOf = (template: CloudFormationTemplate) =>
  new DagBuilder({ relaxCdkVpcDefensiveDeps: true }).buildGraph(template);

describe('the CDK-defensive route edge stays for code that runs during the deploy (#6940)', () => {
  beforeEach(() => {
    mocks.provisionResource.mockReset();
  });

  it("a custom resource handler's VPC function keeps its DependsOn on the route", () => {
    expect(graphOf(VPC_CR).hasEdge('Route', 'Fn')).toBe(true);
  });

  it('a VPC function no custom resource reaches (a Function URL behind CloudFront) still relaxes', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Nat: { Type: 'AWS::EC2::NatGateway', Properties: {} },
        Route: { Type: 'AWS::EC2::Route', Properties: { NatGatewayId: { Ref: 'Nat' } } },
        Fn: { Type: 'AWS::Lambda::Function', DependsOn: ['Route'], Properties: {} },
        Url: {
          Type: 'AWS::Lambda::Url',
          DependsOn: ['Route'],
          Properties: { TargetFunctionArn: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
        },
        Cdn: {
          Type: 'AWS::CloudFront::Distribution',
          Properties: { Origin: { 'Fn::GetAtt': ['Url', 'FunctionUrl'] } },
        },
      },
    };
    const graph = graphOf(template);
    expect(graph.hasEdge('Route', 'Fn')).toBe(false);
    expect(graph.hasEdge('Route', 'Url')).toBe(false);
  });

  it('a function upstream of a custom resource only through a Ref chain keeps it too', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Nat: { Type: 'AWS::EC2::NatGateway', Properties: {} },
        Route: { Type: 'AWS::EC2::Route', Properties: { NatGatewayId: { Ref: 'Nat' } } },
        Fn: { Type: 'AWS::Lambda::Function', DependsOn: ['Route'], Properties: {} },
        Alias: { Type: 'AWS::Lambda::Alias', Properties: { FunctionName: { Ref: 'Fn' } } },
        Probe: { Type: 'Custom::Probe', Properties: { ServiceToken: { Ref: 'Alias' } } },
      },
    };
    expect(graphOf(template).hasEdge('Route', 'Fn')).toBe(true);
  });

  it('a function upstream of a nested stack keeps it (the child can hold a custom resource)', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Nat: { Type: 'AWS::EC2::NatGateway', Properties: {} },
        Route: { Type: 'AWS::EC2::Route', Properties: { NatGatewayId: { Ref: 'Nat' } } },
        Fn: { Type: 'AWS::Lambda::Function', DependsOn: ['Route'], Properties: {} },
        Child: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { Parameters: { FnArn: { 'Fn::GetAtt': ['Fn', 'Arn'] } } },
        },
      },
    };
    expect(graphOf(template).hasEdge('Route', 'Fn')).toBe(true);
  });

  it('--concurrency 1: the custom resource is invoked after the route, with no hang', async () => {
    const order: string[] = [];
    await deploy(runFor(VPC_CR, readiness()), order, 1);
    expect(order.indexOf('probe invoked')).toBeGreaterThan(order.indexOf('route provisioned'));
    // The kept edge, not the sequential order: the handler's function is
    // created only after the route.
    expect(order.indexOf('Fn provisioned')).toBeGreaterThan(order.indexOf('route provisioned'));
  });

  it("--no-wait: the invoke also waits for the NAT gateway's deferred readiness behind the route", async () => {
    const order: string[] = [];
    await deploy(runFor(VPC_CR, readiness()), order, 10, async () => {
      await sleep(80);
      order.push('nat available');
    });
    expect(order).toContain('nat available');
    expect(order.indexOf('probe invoked')).toBeGreaterThan(order.indexOf('nat available'));
    expect(order.indexOf('probe invoked')).toBeGreaterThan(order.indexOf('route provisioned'));
  });
});

describe('a nested child custom resource and its parent row (#6940 N1 / S1)', () => {
  beforeEach(() => {
    mocks.provisionResource.mockReset();
  });

  const CHILD: CloudFormationTemplate = {
    Resources: {
      Db: { Type: 'AWS::RDS::DBCluster', Properties: {} },
      Seed: { Type: 'Custom::Seed', DependsOn: 'Db', Properties: {} },
    },
  };

  const seedChange = { changeType: 'CREATE', resourceType: 'Custom::Seed' } as unknown as ResourceChange;

  it("walks its own engine first, then the parent row's", async () => {
    const order: string[] = [];
    const run = readiness();
    run.record(
      'Db',
      'AWS::RDS::DBCluster',
      'CREATE',
      new Map([['db-1', { wait: async () => void order.push('own'), inContext: (fn) => fn() }]])
    );
    mocks.provisionResource.mockImplementation(async () => {
      await awaitUpstreamReadiness('Seed');
    });
    await withDeferredReadinessScope(
      {
        logicalId: 'ChildStack',
        resourceType: 'AWS::CloudFormation::Stack',
        deferred: new Map(),
        awaitUpstreamReadiness: async () => undefined,
        awaitUpstreamReadinessRaw: async () => void order.push('parent'),
        awaitDeferredResource: () => undefined,
      },
      () =>
        provisionCreateUpdateNode(runFor(CHILD, run), new DagExecutor(), () => undefined, {
          id: 'Seed',
          data: seedChange,
        })
    );
    expect(order).toStrictEqual(['own', 'parent']);
  });

  it("a parent failure fails the child custom resource as ITS refusal, not the parent row's", async () => {
    mocks.provisionResource.mockImplementation(async () => {
      await awaitUpstreamReadiness('Seed');
    });
    const error = await withDeferredReadinessScope(
      {
        logicalId: 'ChildStack',
        resourceType: 'AWS::CloudFormation::Stack',
        deferred: new Map(),
        awaitUpstreamReadiness: async () => undefined,
        awaitUpstreamReadinessRaw: async () => {
          throw new ProvisioningError(
            'Nat (AWS::EC2::NatGateway) did not become ready (...): failed',
            'AWS::EC2::NatGateway',
            'Nat'
          );
        },
        awaitDeferredResource: () => undefined,
      },
      () =>
        provisionCreateUpdateNode(runFor(CHILD, readiness()), new DagExecutor(), () => undefined, {
          id: 'Seed',
          data: seedChange,
        })
    ).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^Seed was not invoked: Nat \(AWS::EC2::NatGateway\)/);
    expect((error as { logicalId?: string }).logicalId).toBe('Seed');
    expect(isRefusedBeforeApplying(error, 'Seed')).toBe(true);
  });
});
