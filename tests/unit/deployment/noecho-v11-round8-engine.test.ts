import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';
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

vi.mock('../../../src/utils/aws-clients.js', async () => {
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    getAwsClients: () => ({
      cloudFormation: {
        send: vi.fn((command: { input?: { TypeName?: string } }) => {
          const paths = CREATE_ONLY_PATHS_SNAPSHOT.get(command.input?.TypeName ?? '');
          if (paths === undefined) {
            return Promise.reject(
              Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
                name: 'AccessDeniedException',
                $metadata: { httpStatusCode: 403 },
              })
            );
          }
          return Promise.resolve({
            Schema: JSON.stringify({
              createOnlyProperties: paths.map((path) => `/properties/${path.join('/')}`),
              writeOnlyProperties: [],
            }),
          });
        }),
      },
      sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    }),
  };
});

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

/**
 * Round 8 of go-to-k/cdkd#4043 / #2449: the deploy-start observed refresh of a
 * record holding `***` (SECURITY 4) and a create-first replacement whose old
 * resource's delete is skipped (CODE m1 / m3).
 */
const STACK = 'noecho-round8-stack';
const REGION = 'us-east-1';
const CR_VALUE = 'cr-generated-secret-value-r8';
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:h';

describe('DeployEngine - NoEcho round 8', () => {
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let events: Record<string, unknown>[];
  const logger = getLogger() as unknown as Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    provider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
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
      {
        dryRun: false,
        eventRecorder: { record: (e: Record<string, unknown>) => void events.push(e) },
        ...options,
      } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  const lastSaved = (): StackState =>
    stateBackend.saveState!.mock.calls.at(-1)![2] as StackState;
  const lines = (fn: ReturnType<typeof vi.fn>): string[] => fn.mock.calls.map((c) => String(c[0]));

  it('masks the deploy-start observed refresh of a pre-v11 reader whose record holds the mask (SECURITY 4)', async () => {
    const state: StackState = {
      version: 10 as never,
      region: REGION,
      stackName: STACK,
      resources: {
        Cr: {
          physicalId: 'cr-1',
          resourceType: 'Custom::Thing',
          properties: { ServiceToken: TOKEN },
          attributes: { Secret: '***' },
          dependencies: [],
        },
        Consumer: {
          physicalId: '/app/c',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/app/c', Type: 'String', Value: '***' },
          attributes: {},
          dependencies: ['Cr'],
        },
      },
      outputs: {},
      lastModified: 0,
    };
    stateBackend.getState!.mockResolvedValue({ state, etag: 'etag-old' });
    provider.readCurrentState!.mockImplementation((physicalId: string) =>
      Promise.resolve(
        physicalId === '/app/c' ? { Name: '/app/c', Type: 'String', Value: CR_VALUE } : undefined
      )
    );
    await makeEngine({ captureObservedState: true }).deploy(STACK, {
      Resources: {
        Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: TOKEN } },
        Consumer: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/c', Type: 'String', Value: { 'Fn::GetAtt': ['Cr', 'Secret'] } },
        },
      },
    } as CloudFormationTemplate);
    // Vacuity guard: the refresh really read the consumer back.
    expect(provider.readCurrentState!.mock.calls.some((c) => c[0] === '/app/c')).toBe(true);
    expect(stateBackend.saveState).toHaveBeenCalled();
    expect(JSON.stringify(stateBackend.saveState!.mock.calls)).not.toContain(CR_VALUE);
    expect(lastSaved().resources['Consumer']!.observedProperties).toEqual({
      Name: '/app/c',
      Type: 'String',
      Value: '***',
    });
  });

  it('keeps the record and counts a skipped delete (exit 2 unless --allow-unaddressed) for a custom resource removed from the template whose properties hold a NoEcho mask (maintainer decision, round 8)', async () => {
    const state: StackState = {
      version: 11 as never,
      region: REGION,
      stackName: STACK,
      resources: {
        Cr: {
          physicalId: 'cr-1',
          resourceType: 'Custom::Thing',
          properties: { ServiceToken: TOKEN, Password: '***' },
          attributes: {},
          dependencies: [],
          noEchoLeaves: [['Password']],
        },
        Keep: {
          physicalId: '/app/k',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: '/app/k', Type: 'String', Value: 'v' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    };
    stateBackend.getState!.mockResolvedValue({ state, etag: 'etag-old' });
    // The REAL provider for the custom resource, so the skip proves the
    // engine threads the record's `noEchoLeaves` into the delete context.
    const cr = new CustomResourceProvider();
    const crDelete = vi.spyOn(cr, 'delete');
    const engine = makeEngine({ captureObservedState: false });
    const registry = (engine as unknown as { providerRegistry: Record<string, unknown> })
      .providerRegistry;
    registry['getProviderFor'] = vi.fn((q: { resourceType: string }) => ({
      provider: q.resourceType === 'Custom::Thing' ? cr : provider,
      provisionedBy: 'sdk',
    }));
    registry['getProvider'] = vi.fn((type: string) => (type === 'Custom::Thing' ? cr : provider));
    const result = await engine.deploy(STACK, {
      Resources: {
        Keep: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/app/k', Type: 'String', Value: 'v' } },
      },
    } as CloudFormationTemplate);
    expect(crDelete).toHaveBeenCalledTimes(1);
    await expect(crDelete.mock.results[0]!.value).resolves.toEqual({
      outcome: 'skipped',
      reason: CR_NOECHO_PROPERTIES_SKIP_REASON,
    });
    // The deploy command exits 2 on a non-zero `deleteSkipped` unless
    // --allow-unaddressed (deploy-unaddressed-exit.test.ts).
    expect(result.deleteSkipped).toBe(1);
    expect(lastSaved().resources['Cr']).toBeDefined();
    expect(lastSaved().resources['Cr']!.properties['Password']).toBe('***');
    expect(lines(logger.warn!).join('\n')).toContain('LEFT IN PLACE');
  });

  function replacementState(): StackState {
    return {
      version: 11 as never,
      region: REGION,
      stackName: STACK,
      resources: {
        Topic: {
          physicalId: 'arn:aws:sns:us-east-1:123456789012:old-name',
          resourceType: 'AWS::SNS::Topic',
          properties: { TopicName: 'old-name', DisplayName: 'd' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    };
  }
  const renamed = {
    Resources: {
      Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'new-name', DisplayName: 'd' } },
    },
  } as CloudFormationTemplate;

  it('reports a create-first replacement whose old-resource delete was skipped as a PARTIAL update, line and summary alike (CODE m1)', async () => {
    stateBackend.getState!.mockResolvedValue({ state: replacementState(), etag: 'etag-old' });
    provider.create!.mockResolvedValue({
      physicalId: 'arn:aws:sns:us-east-1:123456789012:new-name',
      attributes: {},
    });
    provider.delete!.mockResolvedValue({ outcome: 'skipped', reason: 'the delete address is redacted' });
    const result = await makeEngine({ captureObservedState: false }).deploy(STACK, renamed);
    // The deploy command adds `updatePartial` to the unaddressed total that
    // exits 2 unless --allow-unaddressed.
    expect(result.updatePartial).toBe(1);
    expect(result.updated).toBe(0);
    expect(
      events.some((e) => e['eventType'] === 'RESOURCE_SKIPPED' && e['logicalId'] === 'Topic')
    ).toBe(true);
    const warned = lines(logger.warn!).join('\n');
    expect(warned).toContain('replaced');
    expect(warned).toContain('partial (');
    expect(lines(logger.info!).some((l) => l.includes('replaced') && l.includes('Topic'))).toBe(
      false
    );
  });

  it("threads the replaced record's noEchoLeaves into the old resource's delete context (go-to-k/cdkd#4043)", async () => {
    const state = replacementState();
    state.resources['Topic']!.noEchoLeaves = [['DisplayName']];
    stateBackend.getState!.mockResolvedValue({ state, etag: 'etag-old' });
    provider.create!.mockResolvedValue({
      physicalId: 'arn:aws:sns:us-east-1:123456789012:new-name',
      attributes: {},
    });
    await makeEngine({ captureObservedState: false }).deploy(STACK, renamed);
    const del = provider.delete!.mock.calls.filter((c) => c[0] === 'Topic');
    expect(del).toHaveLength(1);
    expect(del[0]![4]).toHaveProperty('recordedNoEchoLeaves', [['DisplayName']]);
  });

  it('joins a skipped old-resource delete with a partial reason the row already had (CODE m3)', async () => {
    stateBackend.getState!.mockResolvedValue({ state: replacementState(), etag: 'etag-old' });
    const body = vi
      .spyOn(DeployEngine.prototype, 'provisionResourceBody')
      .mockImplementation(async function (this: DeployEngine, logicalId: string, ...rest: unknown[]) {
        const counts = rest[6] as { updatePartial: number } | undefined;
        if (counts) counts.updatePartial++;
        this.replacedDeleteSkips.set(logicalId, 'reason-B');
        return { updatePartial: 'reason-A' };
      });
    try {
      const result = await makeEngine({ captureObservedState: false }).deploy(STACK, renamed);
      expect(result.updatePartial).toBe(1);
      const skipped = events.find(
        (e) => e['eventType'] === 'RESOURCE_SKIPPED' && e['logicalId'] === 'Topic'
      );
      expect(String(skipped?.['reason'])).toContain('reason-A');
      expect(String(skipped?.['reason'])).toContain('reason-B');
    } finally {
      body.mockRestore();
    }
  });
});
