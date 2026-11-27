/**
 * go-to-k/cdkd#7088: a replaced resource whose NEW copy carries the old
 * copy's physical id, while naming another resource (a stage moved to another
 * API: both are `prod`), is not "held" by the new record. When the old copy's
 * delete failed, the save dropped its superseded entry as held, and the old
 * stage was left in AWS untracked, although the warning said it was kept.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { executeDeployment } from '../../../src/deployment/deploy-engine/execute.js';
import {
  addSuperseded,
  isSupersededHeldBySameType,
  namesSameResource,
  supersededHolderOf,
  supersededResourcesOf,
} from '../../../src/deployment/superseded-resources.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type {
  ResourceChange,
  ResourceState,
  StackState,
  SupersededResourceRecord,
} from '../../../src/types/state.js';

const printed = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
vi.mock('../../../src/utils/logger.js', async () => {
  const sink = (level: 'info' | 'warn') =>
    vi.fn((message: unknown) => {
      printed[level].push(String(message));
    });
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: sink('info'),
    warn: sink('warn'),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

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

const STAGE = 'AWS::ApiGateway::Stage';
const INGRESS = 'AWS::EC2::SecurityGroupIngress';

function record(
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  attributes: Record<string, unknown> = {}
): ResourceState {
  return { physicalId, resourceType, properties, attributes, dependencies: [] };
}

const kept = (logicalId: string, state: ResourceState): SupersededResourceRecord => ({
  logicalId,
  supersededAt: 1,
  state,
});

describe('a stage moved to another API whose old copy cannot be deleted stays recorded (#7088)', () => {
  let provider: ResourceProvider;
  let saved: StackState[];

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    saved = [];
    provider = {
      create: vi.fn(async () => ({ physicalId: 'prod', attributes: {} })),
      update: vi.fn(),
      // The old stage on api-a: a base path mapping still uses it.
      delete: vi.fn(async (_logicalId: string, _physicalId: string, _type: string, props) => {
        if ((props as { RestApiId?: string }).RestApiId === 'api-a') {
          const error = new Error('Deleting stage prod failed. Please remove all base path mappings');
          error.name = 'BadRequestException';
          throw error;
        }
        return undefined;
      }),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(): DeployEngine {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    return new DeployEngine(
      {
        getState: vi.fn(),
        saveState: vi.fn(async (_stack: string, _region: string, state: StackState) => {
          saved.push(structuredClone(state));
          return 'etag';
        }),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      { getDirectDependencies: () => [] } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4 } as never,
      'us-east-1'
    );
  }

  it('keeps the old stage in supersededResources when its delete fails', async () => {
    const template = {
      Resources: {
        Stage: { Type: STAGE, Properties: { RestApiId: 'api-b', StageName: 'prod' } },
      },
    } as unknown as CloudFormationTemplate;
    const state = {
      version: 13,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: { Stage: record('prod', STAGE, { RestApiId: 'api-a', StageName: 'prod' }) },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      [
        'Stage',
        {
          logicalId: 'Stage',
          changeType: 'UPDATE',
          resourceType: STAGE,
          currentProperties: { RestApiId: 'api-a', StageName: 'prod' },
          desiredProperties: { RestApiId: 'api-b', StageName: 'prod' },
          propertyChanges: [
            { path: 'RestApiId', oldValue: 'api-a', newValue: 'api-b', requiresReplacement: true },
          ],
        } as unknown as ResourceChange,
      ],
    ]);
    const engine = makeEngine();

    const result = await executeDeployment(
      engine,
      template,
      state,
      changes,
      {} as never,
      [['Stage']],
      'MyStack',
      template,
      undefined,
      undefined,
      'etag-0'
    );
    const final = engine.withParentInfo(result.state);

    expect(final.resources['Stage']?.properties['RestApiId']).toBe('api-b');
    expect(
      supersededResourcesOf(final).map((e) => [e.logicalId, e.state.properties['RestApiId']])
    ).toEqual([['Stage', 'api-a']]);
    expect(saved.length).toBeGreaterThan(0);
    expect(supersededResourcesOf(saved.at(-1)).map((e) => e.state.properties['RestApiId'])).toEqual(
      ['api-a']
    );
  });
});

describe('namesSameResource and the holder checks (#7088)', () => {
  const stageOn = (api: string) => record('prod', STAGE, { RestApiId: api, StageName: 'prod' });

  it('a stage on another API is another resource under the same id', () => {
    expect(namesSameResource(stageOn('api-a'), stageOn('api-b'))).toBe(false);
    expect(namesSameResource(stageOn('api-a'), stageOn('api-a'))).toBe(true);
  });

  it('two ingress records holding different rule ids are two rules', () => {
    const rule = (id: string) =>
      record('sg-1|tcp|443|10.0.0.0/16', INGRESS, { GroupId: 'sg-1', CidrIp: '10.0.0.0/16' }, { Id: id });
    expect(namesSameResource(rule('sgr-0aaa1111bbbb2222c'), rule('sgr-0ddd3333eeee4444f'))).toBe(false);
    expect(namesSameResource(rule('sgr-0aaa1111bbbb2222c'), rule('sgr-0aaa1111bbbb2222c'))).toBe(true);
  });

  it('a type outside the hook keeps "same id, same type" as one resource', () => {
    const topic = (name: string) => record('arn:aws:sns:us-east-1:1:t', 'AWS::SNS::Topic', { TopicName: name });
    expect(namesSameResource(topic('a'), topic('b'))).toBe(true);
  });

  it('a new stage on another API neither holds the old one nor drops it', () => {
    const entry = kept('Stage', stageOn('api-a'));
    const resources = { Stage: stageOn('api-b') };
    expect(supersededHolderOf(entry, resources)).toBeUndefined();
    expect(isSupersededHeldBySameType(entry, resources)).toBe(false);
  });

  it('a stage on the same API still holds it (a rollback took it back)', () => {
    const entry = kept('Stage', stageOn('api-a'));
    const resources = { Stage: stageOn('api-a') };
    expect(supersededHolderOf(entry, resources)).toBe(resources.Stage);
    expect(isSupersededHeldBySameType(entry, resources)).toBe(true);
  });

  it('a record of another type under the id still holds it, unchanged', () => {
    const entry = kept('Stage', stageOn('api-a'));
    const other = record('prod', 'AWS::SSM::Parameter', { Name: 'prod' });
    expect(supersededHolderOf(entry, { Param: other })).toBe(other);
    expect(isSupersededHeldBySameType(entry, { Param: other })).toBe(false);
  });

  it('keeps two kept stages of one id on different APIs as two entries', () => {
    const host: Pick<StackState, 'supersededResources'> = {};
    addSuperseded(host, kept('Stage', stageOn('api-a')));
    addSuperseded(host, kept('Stage', stageOn('api-b')));
    expect(supersededResourcesOf(host).map((e) => e.state.properties['RestApiId'])).toEqual([
      'api-a',
      'api-b',
    ]);
    // The same stage re-recorded still replaces its entry.
    addSuperseded(host, kept('Stage', stageOn('api-a')));
    expect(supersededResourcesOf(host)).toHaveLength(2);
  });
});
