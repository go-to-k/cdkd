import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const stubLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => stubLogger,
};
vi.mock('../../../src/utils/live-renderer.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getLiveRenderer: () => ({
      addTask: vi.fn(),
      updateTaskLabel: vi.fn(),
      removeTask: vi.fn(),
      completeTask: vi.fn(),
      failTask: vi.fn(),
      startTask: vi.fn(),
    }),
  };
});
const fields = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/cc-import-identifier.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getPrimaryIdentifierFields: fields,
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => stubLogger,
  Logger: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState as StateRecord } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6976: the deploy that moves an SDK-recorded resource onto Cloud
 * Control addresses it by the type's Cloud Control identifier and records
 * that id; a resource already on Cloud Control keeps its id.
 */
const STACK = 'MyStack';
const LOGICAL_ID = 'Dep';
const TYPE = 'AWS::ApiGateway::Deployment';
const RECORDED_PROPS = { RestApiId: 'r1' };
const DESIRED_PROPS = { RestApiId: 'r1', StageDescription: { Description: 'x' } };

describe('the SDK-to-Cloud Control move translates the physical id (#6976)', () => {
  let update: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fields.mockImplementation(() => Promise.resolve(['DeploymentId', 'RestApiId']));
  });

  function makeEngine() {
    update = vi.fn().mockImplementation((_l: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false })
    );
    const provider = {
      create: vi.fn(),
      update,
      delete: vi.fn(),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({
        provider,
        provisionedBy: 'cc-api',
        ccRouteReason: { properties: ['StageDescription'] },
      }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag') } as unknown as never,
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
        calculateDiff: vi.fn().mockResolvedValue(new Map()),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as unknown as never,
      registry as unknown as never,
      {},
      'us-east-1'
    );
  }

  async function runUpdate(recordedBy: 'sdk' | 'cc-api' | undefined, physicalId: string) {
    const engine = makeEngine();
    const change = {
      logicalId: LOGICAL_ID,
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: RECORDED_PROPS,
      desiredProperties: DESIRED_PROPS,
      propertyChanges: [
        {
          path: 'StageDescription',
          oldValue: undefined,
          newValue: DESIRED_PROPS.StageDescription,
          requiresReplacement: false,
        },
      ],
    } as unknown as ResourceChange;
    const stateResources: Record<string, StateRecord> = {
      [LOGICAL_ID]: {
        physicalId,
        resourceType: TYPE,
        properties: RECORDED_PROPS,
        attributes: {},
        dependencies: [],
        ...(recordedBy !== undefined && { provisionedBy: recordedBy }),
      } as unknown as StateRecord,
    };
    await provisionResource(engine, LOGICAL_ID, change, stateResources, STACK, {
      Resources: { [LOGICAL_ID]: { Type: TYPE, Properties: DESIRED_PROPS } },
    });
    return stateResources[LOGICAL_ID]!;
  }

  it.each([['sdk' as const], [undefined]])(
    'sends and records the Cloud Control identifier for a %s record',
    async (recordedBy) => {
      const record = await runUpdate(recordedBy, 'dep1');
      expect(update.mock.calls[0]![1]).toBe('dep1|r1');
      expect(record.physicalId).toBe('dep1|r1');
      expect(record.provisionedBy).toBe('cc-api');
    }
  );

  it('keeps a Cloud Control record\'s id as it is', async () => {
    const record = await runUpdate('cc-api', 'dep1|r1');
    expect(update.mock.calls[0]![1]).toBe('dep1|r1');
    expect(record.physicalId).toBe('dep1|r1');
    expect(fields).not.toHaveBeenCalled();
  });
});
