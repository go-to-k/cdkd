/**
 * go-to-k/cdkd#4911: a provider that replaces a resource inside its own
 * `update()` (ACM on a `ValidationMethod` change) and cannot delete the OLD
 * one reports `{ outcome: 'partial', wasReplaced: true }`. The op it journals
 * carries go-to-k/cdkd#2631's `oldResourceMaySurvive`, so a rollback triggered
 * by a later failure of the same deploy reads AWS before re-creating the old
 * resource instead of minting a duplicate. The deliberate
 * `UpdateReplacePolicy: Retain` survivor of the update-not-supported fallback
 * is also a `'partial'` replacement, and stays unmarked: it is recorded as
 * retained. The verdict is the provider's: `'kept'` only when it says AWS
 * refused the delete outright, `'unconfirmed'` otherwise.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { CompletedOperation } from '../../../src/deployment/rollback-executor.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

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
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
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

const CERT = 'AWS::CertificateManager::Certificate';
const TOPIC = 'AWS::SNS::Topic';

describe("a provider's in-update replacement whose old delete failed (#4911)", () => {
  let provider: ResourceProvider;
  /** Certificates alive in AWS. */
  let live: Set<string>;
  /** What the provider's `update()` of the certificate does. */
  let certUpdate: 'partial' | 'partial-kept' | 'clean' | 'partial-in-place' | 'unsupported';
  let creates: number;
  let journaled: CompletedOperation[][];

  beforeEach(() => {
    vi.clearAllMocks();
    printed.info.length = 0;
    printed.warn.length = 0;
    live = new Set(['cert-old']);
    certUpdate = 'partial';
    creates = 0;
    journaled = [];
    const mint = (): { physicalId: string; attributes: Record<string, unknown> } => {
      const id = ++creates === 1 ? 'cert-new' : `cert-${creates}`;
      live.add(id);
      return { physicalId: id, attributes: {} };
    };
    provider = {
      create: vi.fn(async () => mint()),
      update: vi.fn(async (logicalId: string, physicalId: string) => {
        if (logicalId === 'Topic') throw new Error('InvalidParameter: topic update rejected');
        if (certUpdate === 'unsupported') {
          throw new ResourceUpdateNotSupportedError(CERT, logicalId);
        }
        if (certUpdate === 'partial-in-place') {
          return { physicalId, wasReplaced: false, outcome: 'partial', reason: 'a child left one' };
        }
        // The ACM provider's `changedImmutable` arm: create, then delete the
        // old certificate, which ACM refuses while a consumer still uses it.
        const created = mint();
        if (certUpdate === 'clean') {
          live.delete(physicalId);
          return { physicalId: created.physicalId, wasReplaced: true, attributes: {} };
        }
        return {
          physicalId: created.physicalId,
          wasReplaced: true,
          attributes: {},
          outcome: 'partial',
          reason: `old certificate ${physicalId} is still in use by another resource and was not deleted`,
          // The provider's word that AWS refused the delete outright.
          ...(certUpdate === 'partial-kept' && { oldResourceSurvivor: 'kept' }),
        };
      }),
      delete: vi.fn(async (_logicalId: string, physicalId: string) => {
        live.delete(physicalId);
        return undefined;
      }),
      readCurrentState: vi.fn(async (physicalId: string) =>
        live.has(physicalId) ? { DomainName: 'example.com' } : RESOURCE_NOT_FOUND
      ),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
  });

  function makeEngine(noRollback: boolean, replace = false): InstanceType<typeof DeployEngine> {
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    const engine = new DeployEngine(
      {
        getState: vi.fn(),
        saveState: vi.fn().mockResolvedValue('etag'),
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        saveRollbackJournal: vi.fn().mockResolvedValue(undefined),
        deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
        purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
        rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
        warmConnections: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {} as unknown as never,
      {
        getDirectDependencies: (_d: unknown, id: string) => (id === 'Topic' ? ['Cert'] : []),
      } as unknown as never,
      {} as unknown as never,
      registry as unknown as never,
      { concurrency: 4, noRollback, ...(replace && { replace: true }) } as never,
      'us-east-1'
    );
    const write = (
      engine as unknown as { writeRollbackJournalSegment: (...args: unknown[]) => Promise<unknown> }
    ).writeRollbackJournalSegment.bind(engine);
    (
      engine as unknown as { writeRollbackJournalSegment: (...args: unknown[]) => Promise<unknown> }
    ).writeRollbackJournalSegment = async (...args: unknown[]) => {
      journaled.push(structuredClone(args[1] as CompletedOperation[]));
      return write(...args);
    };
    return engine;
  }

  async function deploy(
    opts: { noRollback?: boolean; updateReplacePolicy?: string; replace?: boolean } = {}
  ): Promise<unknown> {
    const engine = makeEngine(opts.noRollback ?? true, opts.replace ?? false);
    const certProps = { DomainName: 'example.com', ValidationMethod: 'EMAIL' };
    const template = {
      Resources: {
        Cert: {
          Type: CERT,
          Properties: certProps,
          ...(opts.updateReplacePolicy !== undefined && {
            UpdateReplacePolicy: opts.updateReplacePolicy,
          }),
        },
        Topic: { Type: TOPIC, Properties: { DisplayName: 'v2' } },
      },
    } as unknown as CloudFormationTemplate;
    const record = (physicalId: string, resourceType: string, properties: Record<string, unknown>) =>
      ({
        physicalId,
        resourceType,
        properties,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      }) as ResourceState;
    const oldCertProps = { DomainName: 'example.com', ValidationMethod: 'DNS' };
    const currentState = {
      version: 12,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {
        Cert: record('cert-old', CERT, oldCertProps),
        Topic: record('topic', TOPIC, { DisplayName: 'v1' }),
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const changes = new Map<string, ResourceChange>([
      [
        'Cert',
        {
          logicalId: 'Cert',
          changeType: 'UPDATE',
          resourceType: CERT,
          currentProperties: oldCertProps,
          desiredProperties: certProps,
          // Not in the create-only snapshot: the engine calls `update()`.
          propertyChanges: [
            {
              path: 'ValidationMethod',
              oldValue: 'DNS',
              newValue: 'EMAIL',
              requiresReplacement: false,
            },
          ],
        } as unknown as ResourceChange,
      ],
      [
        'Topic',
        {
          logicalId: 'Topic',
          changeType: 'UPDATE',
          resourceType: TOPIC,
          currentProperties: { DisplayName: 'v1' },
          desiredProperties: { DisplayName: 'v2' },
          propertyChanges: [
            { path: 'DisplayName', oldValue: 'v1', newValue: 'v2', requiresReplacement: false },
          ],
        } as unknown as ResourceChange,
      ],
    ]);
    return (
      engine as unknown as { executeDeployment: (...args: unknown[]) => Promise<unknown> }
    ).executeDeployment(template, currentState, changes, {}, [['Cert'], ['Topic']], 'MyStack', template);
  }

  const certOp = (): CompletedOperation => {
    expect(journaled).toHaveLength(1);
    return journaled[0]!.find((o) => o.logicalId === 'Cert')!;
  };

  it('marks the op unconfirmed when the provider replaced it and could not delete the old one', async () => {
    await expect(deploy()).rejects.toThrow();
    const op = certOp();
    expect(op.wasReplaced).toBe(true);
    expect(op.physicalId).toBe('cert-new');
    expect(op.oldResourceRetained).toBe(false);
    expect(op.oldResourceMaySurvive).toBe('unconfirmed');
  });

  it('marks the op kept when the provider says AWS refused the delete outright', async () => {
    certUpdate = 'partial-kept';
    await expect(deploy()).rejects.toThrow();
    expect(certOp().oldResourceMaySurvive).toBe('kept');
  });

  it('journals no mark when the provider replaced it and deleted the old one', async () => {
    certUpdate = 'clean';
    await expect(deploy()).rejects.toThrow();
    const op = certOp();
    expect(op.wasReplaced).toBe(true);
    expect('oldResourceMaySurvive' in op).toBe(false);
  });

  it('journals no mark for a partial update that replaced nothing', async () => {
    certUpdate = 'partial-in-place';
    await expect(deploy()).rejects.toThrow();
    const op = certOp();
    expect(op.wasReplaced).toBe(false);
    expect('oldResourceMaySurvive' in op).toBe(false);
  });

  it('journals no mark for the deliberate UpdateReplacePolicy: Retain survivor', async () => {
    certUpdate = 'unsupported';
    await expect(deploy({ updateReplacePolicy: 'Retain', replace: true })).rejects.toThrow();
    // The fallback's create-only arm ran: the old certificate was kept on purpose.
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(
      printed.warn.some((l) => l.includes('partial (UpdateReplacePolicy: Retain kept the old'))
    ).toBe(true);
    const op = certOp();
    expect(op.wasReplaced).toBe(true);
    expect(op.oldResourceRetained).toBe(true);
    expect('oldResourceMaySurvive' in op).toBe(false);
  });

  it('the automatic rollback reads AWS and re-creates no duplicate of a surviving old certificate', async () => {
    await expect(deploy({ noRollback: false })).rejects.toThrow();
    // One create (the provider's replacement), none from the rollback.
    expect(creates).toBe(1);
    expect(provider.readCurrentState).toHaveBeenCalledWith(
      'cert-old',
      'Cert',
      CERT,
      expect.anything()
    );
    expect([...live].sort()).toEqual(['cert-new', 'cert-old']);
    expect(printed.warn.some((l) => l.includes('Cannot reverse the replacement of Cert'))).toBe(
      true
    );
  });

  it('the automatic rollback re-adopts an old certificate AWS refused to delete', async () => {
    certUpdate = 'partial-kept';
    await expect(deploy({ noRollback: false })).rejects.toThrow();
    // No copy of the old certificate; the replacement is deleted.
    expect(creates).toBe(1);
    expect([...live]).toEqual(['cert-old']);
    expect(
      printed.warn.some(
        (l) => l.includes('the old resource of Cert') && l.includes('re-adopted instead of re-created')
      )
    ).toBe(true);
  });

  it('the automatic rollback re-creates the old certificate when AWS reports it gone', async () => {
    // The provider reported the delete failed, but it went through in AWS.
    vi.mocked(provider.update).mockImplementationOnce(async (_l: string, physicalId: string) => {
      live.delete(physicalId);
      creates++;
      live.add('cert-new');
      return {
        physicalId: 'cert-new',
        wasReplaced: true,
        attributes: {},
        outcome: 'partial',
        reason: `old certificate ${physicalId} could not be deleted: timed out`,
      };
    });
    await expect(deploy({ noRollback: false })).rejects.toThrow();
    expect(creates).toBe(2);
    expect(printed.info.some((l) => l.includes('is gone — re-creating it'))).toBe(true);
  });
});
