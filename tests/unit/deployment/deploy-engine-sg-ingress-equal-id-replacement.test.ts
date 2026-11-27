import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
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

type StateRecord = {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  dependencies: string[];
  provisionedBy?: 'sdk' | 'cc-api';
};

/**
 * go-to-k/cdkd#7071: a standalone ingress rule's id is
 * `<GroupId>|<IpProtocol>|<FromPort>|<ToPort>`, with no source, so changing its
 * create-only source creates a NEW rule under the old id. The engine must keep
 * it and revoke the old rule through the old record (its own source and `sgr-`
 * id), not refuse it as an adopted existing resource, which left the new rule
 * authorized and recorded nowhere. The CONTROL (the same source) keeps the
 * refusal.
 */
describe('DeployEngine — an equal SecurityGroupIngress id from another source (go-to-k/cdkd#7071)', () => {
  const TYPE = 'AWS::EC2::SecurityGroupIngress';
  const ID = 'sg-0dst|tcp|443|443';
  const base = { GroupId: 'sg-0dst', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 };
  const OLD = { ...base, CidrIp: '10.0.0.0/16' };
  const NEW = { ...base, CidrIp: '0.0.0.0/0' };
  const OLD_SG = { ...base, SourceSecurityGroupId: 'sg-0old' };
  const NEW_SG = { ...base, SourceSecurityGroupId: 'sg-0new' };
  const SAME_OLD = { ...base, CidrIp: '10.0.0.5/16' };
  const SAME_NEW = { ...base, CidrIp: '10.0.0.0/16' };

  let provider: ResourceProvider;
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
    provider = {
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        return { physicalId: ID, attributes: { Id: 'sgr-0bb2' } };
      }),
      update: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(): InstanceType<typeof DeployEngine> {
    const mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
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
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
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
      {},
      'us-east-1'
    );
  }

  async function invokeProvision(
    oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
    changedPath: string,
    withRecordsView = true,
    extraRecords: Record<string, StateRecord> = {}
  ): Promise<Record<string, StateRecord>> {
    const change: ResourceChange = {
      logicalId: 'Rule',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: oldProps,
      desiredProperties: newProps,
      propertyChanges: [
        {
          path: changedPath,
          oldValue: oldProps[changedPath],
          newValue: newProps[changedPath],
          requiresReplacement: true,
        },
      ],
    };
    const stateResources: Record<string, StateRecord> = {
      Rule: {
        physicalId: ID,
        resourceType: TYPE,
        properties: oldProps,
        attributes: { Id: 'sgr-0aa1' },
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
    const template: CloudFormationTemplate = {
      Resources: { Rule: { Type: TYPE, Properties: newProps } },
    };
    const engine = makeEngine();
    if (withRecordsView) {
      const records = { ...stateResources, ...extraRecords };
      engine.stackRecordsView = {
        live: () => Object.entries(records),
        survivors: () => Object.entries(records),
      } as unknown as typeof engine.stackRecordsView;
    }
    await provisionResource(engine, 'Rule', change, stateResources, 'MyStack', template);
    return stateResources;
  }

  it.each([
    ['a CIDR change', OLD, NEW, 'CidrIp'],
    ['a source group change', OLD_SG, NEW_SG, 'SourceSecurityGroupId'],
  ])('keeps the new rule and revokes the old one for %s', async (_n, oldProps, newProps, path) => {
    const state = await invokeProvision(oldProps, newProps, path);

    expect(callOrder).toEqual(['create', 'delete']);
    // The OLD record's source and sgr- id address the revoke, never the new rule's.
    expect(provider.delete).toHaveBeenCalledWith(
      'Rule',
      ID,
      TYPE,
      oldProps,
      expect.objectContaining({ recordedAttributes: { Id: 'sgr-0aa1' } })
    );
    expect(state['Rule']!.physicalId).toBe(ID);
    expect(state['Rule']!.properties).toEqual(newProps);
    expect(state['Rule']!.attributes).toEqual({ Id: 'sgr-0bb2' });
  });

  // go-to-k/cdkd#7084: a masked source cannot be compared, so the refusal
  // stays; but the create's sgr- id is not the record's, so it made a new rule,
  // which is revoked by that id before the refusal.
  it('revokes the rule a masked-source create made, then refuses', async () => {
    // The record holds the mask; the deploy sends the resolved new value.
    const masked = { ...base, CidrIp: '***' };
    const err = await invokeProvision(masked, NEW, 'CidrIp').then(
      () => null,
      (e: unknown) => e
    );
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;

    expect(e?.cause?.code ?? e?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    expect(callOrder).toEqual(['create', 'delete']);
    expect(provider.delete).toHaveBeenCalledWith(
      'Rule',
      ID,
      TYPE,
      NEW,
      expect.objectContaining({ recordedAttributes: { Id: 'sgr-0bb2' } })
    );
    expect(String(e?.cause?.message ?? e?.message)).toContain('was deleted again');
  });

  it('keeps a rule another record of the stack holds, and says so', async () => {
    const masked = { ...base, CidrIp: '***' };
    const other: StateRecord = {
      physicalId: ID,
      resourceType: TYPE,
      properties: NEW,
      attributes: { Id: 'sgr-0bb2' },
      dependencies: [],
      provisionedBy: 'sdk',
    };
    const err = await invokeProvision(masked, NEW, 'CidrIp', true, { Other: other }).then(
      () => null,
      (e: unknown) => e
    );
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;

    expect(e?.cause?.code ?? e?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    expect(provider.delete).not.toHaveBeenCalled();
    expect(String(e?.cause?.message ?? e?.message)).toContain("is Other's, so it was kept");
  });

  it('names the rule instead of deleting it when the stack records cannot be read', async () => {
    const masked = { ...base, CidrIp: '***' };
    const err = await invokeProvision(masked, NEW, 'CidrIp', false).then(
      () => null,
      (e: unknown) => e
    );
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;

    expect(e?.cause?.code ?? e?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    expect(provider.delete).not.toHaveBeenCalled();
    expect(String(e?.cause?.message ?? e?.message)).toContain('(sgr-0bb2) was left in place');
  });

  it('keeps the refusal, and names the rule, when its delete fails', async () => {
    vi.mocked(provider.delete).mockRejectedValue(new Error('UnauthorizedOperation: not allowed'));
    const masked = { ...base, CidrIp: '***' };
    const err = await invokeProvision(masked, NEW, 'CidrIp').then(
      () => null,
      (e: unknown) => e
    );
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;

    expect(e?.cause?.code ?? e?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    expect(String(e?.cause?.message ?? e?.message)).toContain('its delete failed');
  });

  it('does not claim a skipped delete deleted the rule', async () => {
    vi.mocked(provider.delete).mockResolvedValue({ outcome: 'skipped', reason: 'not confirmed' } as never);
    const masked = { ...base, CidrIp: '***' };
    const err = await invokeProvision(masked, NEW, 'CidrIp').then(
      () => null,
      (e: unknown) => e
    );
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;

    expect(String(e?.cause?.message ?? e?.message)).toContain('its delete was not confirmed');
    expect(String(e?.cause?.message ?? e?.message)).not.toContain('deleted again');
  });

  it('CONTROL: a masked-source create that returned the recorded rule deletes nothing', async () => {
    vi.mocked(provider.create).mockImplementation(async () => {
      callOrder.push('create');
      return { physicalId: ID, attributes: { Id: 'sgr-0aa1' } };
    });
    // The record holds the mask; the deploy sends the resolved new value.
    const masked = { ...base, CidrIp: '***' };
    const err = await invokeProvision(masked, NEW, 'CidrIp').then(
      () => null,
      (e: unknown) => e
    );
    const e = err as { code?: string; cause?: { code?: string } } | null;

    expect(e?.cause?.code ?? e?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it('CONTROL: two spellings of one network keep the name-idempotent refusal', async () => {
    // EC2 hands the existing rule back for a duplicate: the record's sgr- id.
    vi.mocked(provider.create).mockImplementation(async () => {
      callOrder.push('create');
      return { physicalId: ID, attributes: { Id: 'sgr-0aa1' } };
    });
    const err = await invokeProvision(SAME_OLD, SAME_NEW, 'CidrIp').then(
      () => null,
      (e: unknown) => e
    );
    const e = err as { code?: string; cause?: { code?: string } } | null;

    expect(e?.cause?.code ?? e?.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    expect(provider.delete).not.toHaveBeenCalled();
  });
});
