/**
 * A diff-clean deploy saves a cross-stack read its record does not list
 * (go-to-k/cdkd#6400). `state.imports` is what refuses a producer destroy, and
 * a record an older `cdkd import` wrote has none; before the fix the no-change
 * path saved only when something else moved, so that record kept no strong
 * reference until a deploy with a resource change.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState, StateImportEntry } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

const SECRET_ID = 'no-change-6400-secret';
const PASSWORD = 'hunter2-no-change-6400-plaintext';
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: { input?: { SecretId?: string } }): Promise<unknown> {
      if (command.input?.SecretId !== SECRET_ID) throw new Error('unexpected secret id');
      return { SecretString: JSON.stringify({ password: PASSWORD }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const SSM = 'AWS::SSM::Parameter';
const STACK = 'Consumer6400';
const REGION = 'us-east-1';
const SHARED: StateImportEntry = { exportName: 'Shared', sourceStack: 'Producer', sourceRegion: REGION };

const SECRET_REF = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}`;
const template = (importArg: unknown = 'Shared'): CloudFormationTemplate =>
  ({
    Resources: { P: { Type: SSM, Properties: { Type: 'String', Value: 'v' } } },
    Outputs: { Imported: { Value: { 'Fn::ImportValue': importArg } } },
  }) as unknown as CloudFormationTemplate;

const record: ResourceState = {
  physicalId: 'p-phys',
  resourceType: SSM,
  properties: { Type: 'String', Value: 'v' },
  observedProperties: { Type: 'String', Value: 'v' },
  attributes: {},
};

const consumer = (imports?: unknown): StackState => ({
  version: STATE_SCHEMA_VERSION_CURRENT,
  region: REGION,
  stackName: STACK,
  resources: { P: record },
  outputs: { Imported: 'shared-value' },
  exportNames: [],
  ...(imports !== undefined && { imports: imports as StateImportEntry[] }),
  lastModified: 0,
});

const producer: StackState = {
  version: STATE_SCHEMA_VERSION_CURRENT,
  region: REGION,
  stackName: 'Producer',
  resources: {},
  outputs: { Shared: 'shared-value', [`exp-${PASSWORD}`]: 'shared-value' },
  exportNames: ['Shared', `exp-${PASSWORD}`],
  lastModified: 0,
};

describe('a no-change deploy saves imports the record lacks (#6400)', () => {
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStateBackend = {
      getState: vi.fn(),
      listStacks: vi.fn().mockResolvedValue([
        { stackName: 'Producer', region: REGION },
        { stackName: STACK, region: REGION },
      ]),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
  });

  function deploy(state: StackState, tpl = template()): Promise<unknown> {
    mockStateBackend.getState!.mockImplementation(async (name: string) =>
      name === STACK
        ? { state, etag: 'etag-old' }
        : name === 'Producer'
          ? { state: producer, etag: 'etag-p' }
          : null
    );
    const provider = { create: vi.fn(), update: vi.fn(), delete: vi.fn(), getAttribute: vi.fn() };
    const engine = new DeployEngine(
      mockStateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      {
        calculateDiff: vi
          .fn()
          .mockResolvedValue(new Map([['P', { logicalId: 'P', changeType: 'NO_CHANGE', resourceType: SSM }]])),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false },
      REGION
    );
    return engine.deploy(STACK, tpl);
  }

  it('saves the import a record without one resolves', async () => {
    await deploy(consumer());
    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState!.mock.calls[0]![2] as StackState;
    expect(saved.imports).toEqual([SHARED]);
  });

  it('writes nothing when the record already lists the import', async () => {
    await deploy(consumer([SHARED]));
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('writes nothing when the record spells the region in another case', async () => {
    await deploy(consumer([{ ...SHARED, sourceRegion: 'US-EAST-1' }]));
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('saves a secret-built import redacted, the positive twin of the case below', async () => {
    await deploy(consumer(), template({ 'Fn::Join': ['', ['exp-', SECRET_REF]] }));
    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState!.mock.calls[0]![2] as StackState;
    expect(saved.imports).toEqual([{ ...SHARED, exportName: `exp-${SECRET_REF}` }]);
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
  });

  it('writes nothing when the record holds the redacted spelling of a secret-built name', async () => {
    const secretTemplate = template({ 'Fn::Join': ['', ['exp-', SECRET_REF]] });
    await deploy(consumer([{ ...SHARED, exportName: `exp-${SECRET_REF}` }]), secretTemplate);
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('does not fail an unchanged deploy over an imports value that is not a list', async () => {
    await expect(deploy(consumer({}))).resolves.toBeDefined();
  });
});
