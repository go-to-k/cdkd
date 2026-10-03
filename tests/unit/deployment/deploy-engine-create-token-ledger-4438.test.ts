import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

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

import { reserveStackCreateToken } from '../../../src/provisioning/providers/create-token-ledger.js';

/**
 * go-to-k/cdkd#4438: the deploy engine binds the stack's create-token ledger
 * around a deploy, and a `DeletionPolicy: Retain` removal of a resource that
 * holds a ledger token rotates the ledger's nonce.
 */
describe('DeployEngine and the create-token ledger (go-to-k/cdkd#4438)', () => {
  let stateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    loadCreateTokenLedger: ReturnType<typeof vi.fn>;
    saveCreateTokenLedger: ReturnType<typeof vi.fn>;
  };
  let deleteProvider: ResourceProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag'),
      loadCreateTokenLedger: vi.fn().mockResolvedValue({
        ledgerVersion: 1,
        nonce: 'n-0',
        sent: { Target: { base: 'b', token: 't', firstSentAt: 1 } },
      }),
      saveCreateTokenLedger: vi.fn().mockResolvedValue(undefined),
    };
    deleteProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(deleteProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: deleteProvider, provisionedBy: 'sdk' }),
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
      options,
      'us-east-1'
    );
  }

  /** Run `body` as the deploy body `deploy()` scopes, instead of the real one. */
  async function deployRunning(
    engine: InstanceType<typeof DeployEngine>,
    body: () => Promise<void>
  ): Promise<void> {
    (engine as unknown as { doDeploy: () => Promise<unknown> }).doDeploy = async () => {
      await body();
      return {};
    };
    await engine.deploy('MyStack', { Resources: {} } as CloudFormationTemplate);
  }

  it("binds the stack's ledger around the deploy: a create token reads and writes it", async () => {
    let value = '';
    await deployRunning(makeEngine(), async () => {
      value = (await reserveStackCreateToken({ logicalId: 'Fs', immutableInputs: [], maxLength: 63 }))
        .value;
    });
    expect(stateBackend.loadCreateTokenLedger).toHaveBeenCalledWith('MyStack', 'us-east-1');
    const [stack, region, doc] = stateBackend.saveCreateTokenLedger.mock.calls[0]!;
    expect([stack, region]).toEqual(['MyStack', 'us-east-1']);
    expect(doc.sent.Fs.token).toBe(value);
  });

  it('binds no ledger under --dry-run', async () => {
    await deployRunning(makeEngine({ dryRun: true }), async () => {
      await reserveStackCreateToken({ logicalId: 'Fs', immutableInputs: [], maxLength: 63 });
    });
    expect(stateBackend.loadCreateTokenLedger).not.toHaveBeenCalled();
    expect(stateBackend.saveCreateTokenLedger).not.toHaveBeenCalled();
  });

  async function retainDelete(resourceType: string): Promise<void> {
    const engine = makeEngine();
    const change: ResourceChange = {
      logicalId: 'Target',
      changeType: 'DELETE',
      resourceType,
      currentProperties: {},
    };
    const stateResources: Record<string, unknown> = {
      Target: {
        physicalId: 'phys-target',
        resourceType,
        properties: {},
        attributes: {},
        dependencies: [],
        deletionPolicy: 'Retain',
      },
    };
    type ProvisionResourceFn = (
      logicalId: string,
      change: ResourceChange,
      stateResources: Record<string, unknown>,
      stackName: string,
      template: CloudFormationTemplate
    ) => Promise<void>;
    const provisionResource = (
      engine as unknown as { provisionResource: ProvisionResourceFn }
    ).provisionResource.bind(engine);
    await deployRunning(engine, () =>
      provisionResource('Target', change, stateResources, 'MyStack', { Resources: {} })
    );
    expect(deleteProvider.delete).not.toHaveBeenCalled();
    expect(stateResources['Target']).toBeUndefined();
  }

  it('rotates the nonce when a Retain removal leaves an EFS file system holding a token', async () => {
    await retainDelete('AWS::EFS::FileSystem');
    const [, , doc] = stateBackend.saveCreateTokenLedger.mock.calls[0]!;
    expect(doc.nonce).not.toBe('n-0');
    // The let-go logical id's entry goes with it: its next create is a new one.
    expect(doc.sent.Target).toBeUndefined();
  });

  it('does not rotate for a retained type that takes no ledger token', async () => {
    await retainDelete('AWS::S3::Bucket');
    expect(stateBackend.saveCreateTokenLedger).not.toHaveBeenCalled();
  });
});
