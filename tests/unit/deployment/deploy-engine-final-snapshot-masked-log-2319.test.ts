import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
import { secretNameBagFor } from '../../../src/deployment/deploy-engine/masking.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction/log-only.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#2319: every deploy-engine delete site hands the pre-delete
 * final snapshot the delete's own masker, so the helper's debug line -- which
 * quotes a withheld AWS failure's text -- masks a secret-derived name like the
 * delete's lines do. One case per caller: the template-removal delete
 * (`delete.ts`), the update-not-supported fallback (`update-in-place.ts`), the
 * create-first cleanup and the delete-first recreate (`update-replace.ts`).
 */

const { engineDebug } = vi.hoisted(() => ({ engineDebug: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: engineDebug,
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
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ ec2: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const VOLUME = 'AWS::EC2::Volume';
const LINE = 'Failed to create the final snapshot: User: assumed-role/deployer/s3cr3t is not authorized';

let deleteProvider: ResourceProvider;

beforeEach(() => {
  vi.clearAllMocks();
  mockCreatePreDeleteFinalSnapshot.mockImplementation(
    async (_t: string, _p: string, _l: string, _c: unknown, log: { debug(m: string): void }) => {
      log.debug(LINE);
      return 'snap-unit';
    }
  );
  deleteProvider = {
    create: vi.fn().mockResolvedValue({ physicalId: 'phys-new', attributes: {} }),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
});

  function makeEngine(options: Record<string, unknown> = {}): InstanceType<typeof DeployEngine> {
  const mockStateBackend = {
    getState: vi.fn(),
    saveState: vi.fn().mockResolvedValue('etag'),
  };
  const mockLockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
  const mockDagBuilder = {
    buildGraph: vi.fn().mockReturnValue({}),
    getExecutionLevels: vi.fn().mockReturnValue([]),
    getDirectDependencies: vi.fn().mockReturnValue([]),
  };
  const mockDiffCalculator = {
    calculateDiff: vi.fn().mockResolvedValue(new Map()),
    hasChanges: vi.fn().mockReturnValue(false),
    filterByType: vi.fn().mockReturnValue([]),
  };
  const mockProviderRegistry = {
    getProvider: vi.fn().mockReturnValue(deleteProvider),
    getProviderFor: vi.fn().mockReturnValue({ provider: deleteProvider, provisionedBy: 'sdk' }),
    getRegisteredTypes: vi.fn().mockReturnValue([]),
    validateResourceTypes: vi.fn(),
    validateResourceProperties: vi.fn(),
  };
  return new DeployEngine(
    mockStateBackend as unknown as never,
    mockLockManager as unknown as never,
    mockDagBuilder as unknown as never,
    mockDiffCalculator as unknown as never,
    mockProviderRegistry as unknown as never,
    options,
    'us-east-1'
  );
}


/** The engine with `s3cr3t` in Target's secret-name bag (the #2007 bag). */
function engineWithSecret(options: Record<string, unknown> = {}): InstanceType<typeof DeployEngine> {
  const engine = makeEngine(options);
  recordLogOnlyValue(secretNameBagFor(engine.secretsRun, 'Target'), 's3cr3t');
  return engine;
}

function state(extra: Record<string, unknown> = {}): Record<string, ResourceState> {
  return {
    Target: {
      physicalId: 'vol-1',
      resourceType: VOLUME,
      properties: { Size: 1 },
      attributes: {},
      dependencies: [],
      ...extra,
    },
  } as unknown as Record<string, ResourceState>;
}

function replaceChange(requiresReplacement: boolean): ResourceChange {
  return {
    logicalId: 'Target',
    changeType: 'UPDATE',
    resourceType: VOLUME,
    currentProperties: { Size: 1 },
    desiredProperties: { Size: 2 },
    propertyChanges: [{ path: 'Size', oldValue: 1, newValue: 2, requiresReplacement }],
  };
}

const template = (updateReplacePolicy?: string): CloudFormationTemplate =>
  ({
    Resources: {
      Target: {
        Type: VOLUME,
        Properties: { Size: 2 },
        ...(updateReplacePolicy !== undefined && { UpdateReplacePolicy: updateReplacePolicy }),
      },
    },
  }) as unknown as CloudFormationTemplate;

function expectMaskedSnapshotLine(): void {
  expect(mockCreatePreDeleteFinalSnapshot).toHaveBeenCalledTimes(1);
  const shown = engineDebug.mock.calls.map((c) => String(c[0]));
  expect(shown).toContain(LINE.replace('s3cr3t', '***'));
  expect(shown.join('\n')).not.toContain('s3cr3t');
}

describe('the deploy-engine delete sites mask the final snapshot lines (go-to-k/cdkd#2319)', () => {
  it('delete.ts: a template-removal delete under DeletionPolicy: Snapshot', async () => {
    const engine = engineWithSecret();
    await provisionResource(
      engine,
      'Target',
      { logicalId: 'Target', changeType: 'DELETE', resourceType: VOLUME, currentProperties: {} },
      state({ deletionPolicy: 'Snapshot' }),
      'MyStack',
      { Resources: {} }
    );
    expectMaskedSnapshotLine();
  });

  it('update-in-place.ts: the update-not-supported replacement fallback', async () => {
    const engine = engineWithSecret({ replace: true, forceStatefulRecreation: true });
    (deleteProvider.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ResourceUpdateNotSupportedError(VOLUME, 'Target', 'immutable property changed')
    );
    await provisionResource(engine, 'Target', replaceChange(false), state(), 'MyStack', template('Snapshot'));
    expectMaskedSnapshotLine();
  });

  it('update-replace.ts: the create-first cleanup delete', async () => {
    const engine = engineWithSecret({ forceStatefulRecreation: true });
    await provisionResource(engine, 'Target', replaceChange(true), state(), 'MyStack', template('Snapshot'));
    expectMaskedSnapshotLine();
  });

  it('update-replace.ts: the delete-first recreate', async () => {
    const engine = engineWithSecret({
      forceStatefulRecreation: true,
      recreateViaSdkProvider: ['Target'],
    });
    await provisionResource(
      engine,
      'Target',
      replaceChange(true),
      state({ provisionedBy: 'cc-api' }),
      'MyStack',
      template('Snapshot')
    );
    expectMaskedSnapshotLine();
  });
});
