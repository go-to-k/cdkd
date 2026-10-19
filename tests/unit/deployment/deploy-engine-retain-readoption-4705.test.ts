import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { flushKeptForReadoption } from '../../../src/deployment/deploy-engine/delete.js';
import { provisionResource as provisionResourceFn } from '../../../src/deployment/deploy-engine/provision.js';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import { withStackScope } from '../../../src/provisioning/resource-name.js';

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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

const mockCreatePreDeleteFinalSnapshot = vi.hoisted(() => vi.fn());

vi.mock('../../../src/provisioning/final-snapshot.js', async () => {
  const actual = await vi.importActual('../../../src/provisioning/final-snapshot.js');
  return { ...actual, createPreDeleteFinalSnapshot: mockCreatePreDeleteFinalSnapshot };
});

const mockEc2Client = { send: vi.fn() };
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ ec2: mockEc2Client }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

/**
 * go-to-k/cdkd#4705 review CB-14(a): a DEPLOY that removes a Retain resource
 * of a name-adopting type with a generated name records it in
 * `retained.json`, so a later deploy that adds it back takes it back instead
 * of refusing its name -- for an S3 bucket and a log group. A declared name,
 * a type whose create fails on a taken name, and a Delete removal record
 * nothing; earlier entries are kept; parallel removals lose none.
 */
describe('a Retain removal on deploy records what it kept (CB-14a)', () => {
  let saved: unknown[];
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let provider: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    saved = [];
    let current: unknown[] = [{ logicalId: 'Earlier', resourceType: 'AWS::SQS::Queue', physicalId: 'q' }];
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag'),
      loadCreateTokenLedger: vi.fn().mockResolvedValue(null),
      saveCreateTokenLedger: vi.fn().mockResolvedValue(undefined),
      loadRetainedRecord: vi.fn(async () => current),
      saveRetainedResources: vi.fn(async (_s: string, _r: string, entries: unknown[]) => {
        current = entries;
        saved.push(entries);
      }),
    };
    provider = { create: vi.fn(), update: vi.fn(), delete: vi.fn().mockResolvedValue(undefined), getAttribute: vi.fn() };
  });

  function engine(): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      stateBackend as unknown as never,
      { acquireLockWithRetry: vi.fn(), releaseLock: vi.fn() } as unknown as never,
      { buildGraph: vi.fn(), getExecutionLevels: vi.fn(), getDirectDependencies: vi.fn() } as unknown as never,
      { calculateDiff: vi.fn(), hasChanges: vi.fn(), filterByType: vi.fn() } as unknown as never,
      registry as unknown as never,
      {},
      'us-east-1'
    );
  }

  async function remove(
    rows: Array<{ id: string; type: string; physicalId: string; policy: string; properties?: Record<string, unknown>; via?: string }>,
    /** The stack's instance id (go-to-k/cdkd#5064); absent = a legacy stack. */
    stackInstanceId?: string
  ): Promise<void> {
    const e = engine();
    const stateResources: Record<string, unknown> = Object.fromEntries(
      rows.map((r) => [
        r.id,
        { physicalId: r.physicalId, resourceType: r.type, properties: r.properties ?? {}, attributes: {}, dependencies: [], deletionPolicy: r.policy, provisionedBy: r.via ?? 'sdk' },
      ])
    );
    (e as unknown as { doDeploy: () => Promise<unknown> }).doDeploy = async () => {
      const scope = {
        stackName: 'MyStack',
        stackInstanceId,
        nameGenerations: stackInstanceId === undefined ? undefined : new Map<string, number>(),
      };
      await Promise.all(
        rows.map((r) =>
          withStackScope(scope, () =>
          provisionResourceFn(
            e,
            r.id,
            { logicalId: r.id, changeType: 'DELETE', resourceType: r.type, currentProperties: {} } as ResourceChange,
            stateResources as unknown as Record<string, never>,
            'MyStack',
            { Resources: {} }
          )
          )
        )
      );
      // The deploy flow's end, which this stub replaces: one write (H-1).
      await flushKeptForReadoption(e);
      return {};
    };
    await e.deploy('MyStack', { Resources: {} } as CloudFormationTemplate);
  }

  it.each([
    ['AWS::S3::Bucket', 'mystack-bucket'],
    ['AWS::Logs::LogGroup', '/cdkd/MyStack-Logs'],
  ])('%s: the kept resource joins retained.json beside the earlier entries', async (type, physicalId) => {
    await remove([{ id: 'Kept', type, physicalId, policy: 'Retain' }]);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(saved.at(-1)).toEqual([
      { logicalId: 'Earlier', resourceType: 'AWS::SQS::Queue', physicalId: 'q' },
      { logicalId: 'Kept', resourceType: type, physicalId },
    ]);
  });

  it('two Retain removals in parallel both land, in ONE read and ONE write (review H-1)', async () => {
    await remove([
      { id: 'A', type: 'AWS::S3::Bucket', physicalId: 'a', policy: 'Retain' },
      { id: 'B', type: 'AWS::Logs::LogGroup', physicalId: '/cdkd/b', policy: 'Retain' },
    ]);
    expect((saved.at(-1) as Array<{ logicalId: string }>).map((x) => x.logicalId).sort()).toEqual(['A', 'B', 'Earlier']);
    expect(saved).toHaveLength(1);
    expect(stateBackend.loadRetainedRecord).toHaveBeenCalledTimes(1);
  });

  const ID = '3d1f2e4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f';

  it('on a stack with an instance id, records a kept type no create adopts (an IAM role), as a destroy does (go-to-k/cdkd#5064)', async () => {
    await remove([{ id: 'Role', type: 'AWS::IAM::Role', physicalId: 'r', policy: 'Retain' }], ID);
    expect(saved.at(-1)).toEqual([
      { logicalId: 'Earlier', resourceType: 'AWS::SQS::Queue', physicalId: 'q' },
      { logicalId: 'Role', resourceType: 'AWS::IAM::Role', physicalId: 'r' },
    ]);
  });

  it('on a legacy stack, records no kept type a create cannot adopt: no record where #4705 wrote none', async () => {
    await remove([{ id: 'Role', type: 'AWS::IAM::Role', physicalId: 'r', policy: 'Retain' }]);
    expect(saved).toEqual([]);
    expect(stateBackend.loadRetainedRecord).not.toHaveBeenCalled();
  });

  for (const stackInstanceId of [undefined, ID]) {
    it(`records nothing for a declared name, a name-adopting type made through Cloud Control, or a Delete removal (${stackInstanceId === undefined ? 'legacy' : 'id'} stack)`, async () => {
      await remove(
        [
          { id: 'Named', type: 'AWS::S3::Bucket', physicalId: 'mine', policy: 'Retain', properties: { BucketName: 'mine' } },
          { id: 'CcBucket', type: 'AWS::S3::Bucket', physicalId: 'cc', policy: 'Retain', via: 'cc-api' },
          { id: 'Gone', type: 'AWS::S3::Bucket', physicalId: 'g', policy: 'Delete' },
        ],
        stackInstanceId
      );
      expect(saved).toEqual([]);
      expect(stateBackend.loadRetainedRecord).not.toHaveBeenCalled();
    });
  }
});
