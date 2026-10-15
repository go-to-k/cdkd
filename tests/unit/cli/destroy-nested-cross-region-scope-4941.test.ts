import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';

// go-to-k/cdkd#4941, through the REAL runner at both levels and the REAL
// `NestedStackProvider`: a stack recorded in a region other than the CLI's is
// destroyed with the CLI's registry and clients in the nested context the
// caller set. A child provider that captured `ambientRegion()` when it was
// constructed must be one built for the STACK's region, and the child must see
// the stack's clients, or its delete lands on a same-named resource in the
// CLI's region.

const CLI_REGION = 'us-east-1';
const STACK_REGION = 'us-west-2';
const PARENT = 'TestStack';
const CHILD = 'TestStack~Child';
const GRANDCHILD = 'TestStack~Child~Grand';

interface LeafCall {
  logicalId: string;
  constructedRegion: string | undefined;
  callRegion: string | undefined;
  scopeRegion: string | undefined;
  nestedRegistryIsCallers: boolean;
  nestedClientsRegion: string | undefined;
}

const h = vi.hoisted(() => ({
  leafCalls: [] as LeafCall[],
  callerRegistry: undefined as unknown,
  nestedProvider: undefined as unknown,
}));

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/provider-registry.js', () => {
  class FakeRegistry {
    leaf: unknown;
    getProviderFor({ resourceType }: { resourceType: string }) {
      return {
        provider: resourceType === 'AWS::CloudFormation::Stack' ? h.nestedProvider : this.leaf,
        provisionedBy: 'sdk',
      };
    }
    setCustomResourceResponseBucket(): void {}
    allowUnsupportedTypes(): void {}
  }
  return { ProviderRegistry: FakeRegistry };
});
vi.mock('../../../src/provisioning/register-providers.js', async () => {
  const { ambientRegion, currentStackAwsScope } =
    await import('../../../src/utils/stack-aws-scope.js');
  const { getCurrentNestedStackContext } =
    await import('../../../src/provisioning/nested-stack-context.js');
  return {
    loadProviderClasses: vi.fn(async () => ({})),
    // Mirrors a provider whose constructor captures `providerRegion =
    // ambientRegion()` (Kinesis, CodeBuild, Glue, ...).
    registerAllProviders: vi.fn((registry: { leaf: unknown }) => {
      const constructedRegion = ambientRegion();
      registry.leaf = {
        delete: vi.fn(async (logicalId: string) => {
          const nested = getCurrentNestedStackContext();
          h.leafCalls.push({
            logicalId,
            constructedRegion,
            callRegion: ambientRegion(),
            scopeRegion: currentStackAwsScope()?.region,
            nestedRegistryIsCallers: nested?.providerRegistry === h.callerRegistry,
            nestedClientsRegion: (nested?.awsClients as { configuredRegion?: string } | undefined)
              ?.configuredRegion,
          });
        }),
      };
    }),
  };
});
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import {
  ProviderRegistry as RegistryCtor,
} from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import { AwsClients, getAwsClients, setAwsClients } from '../../../src/utils/aws-clients.js';

function res(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'shared-stream-name',
    resourceType: 'AWS::Kinesis::Stream',
    properties: { Name: 'shared-stream-name' },
    attributes: {},
    dependencies: [],
    ...extra,
  };
}

function stateOf(
  stackName: string,
  region: string,
  resources: Record<string, ResourceState>
): StackState {
  return { version: 8, stackName, region, resources, outputs: {}, lastModified: 1 };
}

describe('cdkd destroy of a cross-region stack with a nested child (go-to-k/cdkd#4941)', () => {
  const savedRegion = process.env['AWS_REGION'];
  const savedDefaultRegion = process.env['AWS_DEFAULT_REGION'];
  let callerClients: AwsClients;

  function run(stackRegion: string) {
    const live = new Set([CHILD, GRANDCHILD]);
    const nestedRow = (name: string): ResourceState =>
      res({
        resourceType: 'AWS::CloudFormation::Stack',
        physicalId: `arn:cdkd-local:${stackRegion}:123456789012:nested-stack/${name}`,
        properties: {},
      });
    const stateBackend = {
      getState: vi.fn(async (name: string) => {
        if (!live.has(name)) return null;
        // The child holds a stream AND a grandchild, whose context is the
        // child's spread of the one the runner set.
        const resources: Record<string, ResourceState> =
          name === CHILD
            ? { ChildStream: res({ dependencies: [] }), Grand: nestedRow(CHILD) }
            : { GrandStream: res() };
        return { state: stateOf(name, stackRegion, resources), etag: '"e"' };
      }),
      saveState: vi.fn(async () => '"etag"'),
      deleteState: vi.fn(async (name: string) => {
        live.delete(name);
      }),
      loadRollbackJournal: vi.fn(async () => null),
      dropRollbackJournalFailedOperations: vi.fn(async () => 0),
      listStacks: vi.fn(async () => []),
    } as unknown as S3StateBackend;
    const lockManager = {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
    } as unknown as LockManager;
    // The caller's registry, built in the CLI's region as `destroy.ts` /
    // `state.ts` build theirs.
    const callerRegistry = new RegistryCtor() as unknown as ProviderRegistry;
    registerAllProviders(callerRegistry, {} as never);
    h.callerRegistry = callerRegistry;
    const nestedCtx = {
      stateBackend,
      lockManager,
      providerRegistry: callerRegistry,
      parentStackName: PARENT,
      parentRegion: stackRegion,
      accountId: '123456789012',
      awsClients: callerClients,
      stateBucket: 'test-bucket',
    } as NestedStackProviderContext;
    const parentState = stateOf(PARENT, stackRegion, {
      Child: res({
        resourceType: 'AWS::CloudFormation::Stack',
        physicalId: `arn:cdkd-local:${stackRegion}:123456789012:nested-stack/${PARENT}/Child`,
        properties: {},
      }),
    });
    return withNestedStackContext(nestedCtx, () =>
      runDestroyForStack(PARENT, parentState, {
        stateBackend,
        lockManager,
        providerRegistry: callerRegistry,
        baseAwsClients: callerClients,
        baseRegion: CLI_REGION,
        stateBucket: 'test-bucket',
        skipConfirmation: true,
        stackDestroy: true,
      })
    );
  }

  beforeEach(() => {
    process.env['AWS_REGION'] = CLI_REGION;
    process.env['AWS_DEFAULT_REGION'] = CLI_REGION;
    callerClients = new AwsClients({ region: CLI_REGION });
    setAwsClients(callerClients);
    h.leafCalls.length = 0;
    h.nestedProvider = new NestedStackProvider();
  });

  afterEach(() => {
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
    if (savedDefaultRegion === undefined) delete process.env['AWS_DEFAULT_REGION'];
    else process.env['AWS_DEFAULT_REGION'] = savedDefaultRegion;
    callerClients.destroy();
  });

  it("deletes the child's resource with a provider built for the stack's region and the stack's clients", async () => {
    const result = await run(STACK_REGION);

    expect(result.errorCount).toBe(0);
    // The child's stream and the grandchild's, each through the same checks.
    expect(h.leafCalls.map((c) => c.logicalId).sort()).toEqual(['ChildStream', 'GrandStream']);
    for (const call of h.leafCalls) {
      // Before the fix: the caller's registry, constructed under us-east-1.
      expect(call.constructedRegion).toBe(STACK_REGION);
      expect(call.nestedRegistryIsCallers).toBe(false);
      // The clients a child's final snapshots and grandchildren take.
      expect(call.nestedClientsRegion).toBe(STACK_REGION);
      expect(call.callRegion).toBe(STACK_REGION);
      // Inside the stack AWS scope, not only the process-global switch, which
      // a concurrently destroyed stack could overwrite.
      expect(call.scopeRegion).toBe(STACK_REGION);
    }
    // The process-global region and clients are restored for the next stack
    // of the run (issue #2161).
    expect(process.env['AWS_REGION']).toBe(CLI_REGION);
    expect(getAwsClients()).toBe(callerClients);
  });

  it("keeps the caller's registry and clients for a stack in the CLI's region", async () => {
    const result = await run(CLI_REGION);

    expect(result.errorCount).toBe(0);
    expect(h.leafCalls).toHaveLength(2);
    for (const call of h.leafCalls) {
      expect(call.constructedRegion).toBe(CLI_REGION);
      expect(call.nestedRegistryIsCallers).toBe(true);
      expect(call.nestedClientsRegion).toBe(CLI_REGION);
      expect(call.scopeRegion).toBeUndefined();
    }
    expect(getAwsClients()).toBe(callerClients);
  });
});
