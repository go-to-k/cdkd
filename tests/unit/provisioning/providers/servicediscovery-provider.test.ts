import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-servicediscovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-servicediscovery')>();
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  };
});
vi.mock('../../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
});

import {
  CreateServiceCommand,
  GetNamespaceCommand,
  GetOperationCommand,
  GetServiceCommand,
  ListNamespacesCommand,
  TagResourceCommand,
  UpdateServiceAttributesCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-servicediscovery';
import { ServiceDiscoveryProvider } from '../../../../src/provisioning/providers/servicediscovery-provider.js';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';
import { generatedNameFor, withStackScope } from '../../../../src/provisioning/resource-name.js';
import { getLogger } from '../../../../src/utils/logger.js';

describe('ServiceDiscoveryProvider — import', () => {
  let provider: ServiceDiscoveryProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  function makeNamespaceInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyNs',
      resourceType: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { Name: 'example.local' } as Record<string, unknown>,
      ...overrides,
    };
  }

  function makeServiceInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MySvc',
      resourceType: 'AWS::ServiceDiscovery::Service',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {} as Record<string, unknown>,
      ...overrides,
    };
  }

  describe('PrivateDnsNamespace', () => {
    it('verifies explicit Id via GetNamespace', async () => {
      mockSend.mockResolvedValueOnce({ Namespace: { Id: 'ns-abc' } });
      const result = await provider.import!(
        makeNamespaceInput({ knownPhysicalId: 'ns-abc' })
      );
      expect(result).toEqual({ physicalId: 'ns-abc', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetNamespaceCommand);
    });

    it('finds namespace by Name property when listing', async () => {
      mockSend
        .mockResolvedValueOnce({
          Namespaces: [
            { Id: 'ns-mine', Arn: 'arn:mine', Name: 'example.local' },
            { Id: 'ns-other', Arn: 'arn:other', Name: 'other.local' },
          ],
          NextToken: undefined,
        });
      const result = await provider.import!(makeNamespaceInput());
      expect(result?.physicalId).toBe('ns-mine');
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(ListNamespacesCommand);
    });
  });

  describe('Service', () => {
    it('verifies explicit Id via GetService', async () => {
      const arn = 'arn:aws:servicediscovery:us-east-1:123456789012:service/svc-abc';
      mockSend.mockResolvedValueOnce({ Service: { Id: 'svc-abc', Arn: arn, Name: 'api' } });
      const result = await provider.import!(
        makeServiceInput({ knownPhysicalId: 'svc-abc' })
      );
      // Issue #3627: the same map `create()` records (`Name` resolved to the id).
      expect(result).toStrictEqual({
        physicalId: 'svc-abc',
        attributes: { Id: 'svc-abc', Arn: arn, Name: 'api' },
      });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetServiceCommand);
    });

    // Issue #1134: the `aws:cdk:path` tag walk was removed. AWS rejects
    // `aws:`-prefixed tag writes, so that tag never exists on a real service
    // and the walk could never match. A service without an explicit id now
    // returns null without listing anything.
    it('returns null without listing when no explicit id is supplied', async () => {
      const result = await provider.import!(makeServiceInput());
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  it('returns null for unsupported resource types', async () => {
    // Instance is the one ServiceDiscovery type this provider does NOT
    // handle (HttpNamespace / PublicDnsNamespace gained support in #1044).
    const result = await provider.import!(
      makeServiceInput({ resourceType: 'AWS::ServiceDiscovery::Instance' })
    );
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  describe('HttpNamespace / PublicDnsNamespace', () => {
    it.each([
      ['AWS::ServiceDiscovery::HttpNamespace'],
      ['AWS::ServiceDiscovery::PublicDnsNamespace'],
    ])('verifies explicit Id via GetNamespace for %s', async (resourceType) => {
      mockSend.mockResolvedValueOnce({ Namespace: { Id: 'ns-abc' } });
      const result = await provider.import!(
        makeNamespaceInput({ resourceType, knownPhysicalId: 'ns-abc' })
      );
      expect(result).toEqual({ physicalId: 'ns-abc', attributes: {} });
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(GetNamespaceCommand);
    });
  });
});

describe('ServiceDiscoveryProvider — update', () => {
  let provider: ServiceDiscoveryProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  it.each([
    ['AWS::ServiceDiscovery::PrivateDnsNamespace'],
    ['AWS::ServiceDiscovery::HttpNamespace'],
    ['AWS::ServiceDiscovery::PublicDnsNamespace'],
    ['AWS::ServiceDiscovery::Service'],
  ])(
    'no-op silent success for %s when properties carry no mutable fields',
    async (resourceType) => {
      // When the diff is purely on immutable fields, the
      // replacement-detection layer routes through DELETE+CREATE.
      // If `update()` is somehow called with no mutable fields, it
      // returns silently rather than firing a destructive empty
      // UpdateService (which AWS interprets as "delete this config").
      const result = await provider.update('MyId', 'phys-id', resourceType, {}, {});
      expect(result).toEqual({ physicalId: 'phys-id', wasReplaced: false });
      expect(mockSend).not.toHaveBeenCalled();
    }
  );
});

// Issue #1160: a Description / DnsConfig / HealthCheckConfig removed from the
// template follows CloudFormation (live A/Bs, go-to-k/cdkd#1160
// issuecomment-6272137682 and issuecomment-6281592365): kept on its own;
// cleared (DnsConfig: refused by AWS) beside a Description / HealthCheckConfig
// change; kept beside a DnsRecords-only change, which cdkd applies although
// CloudFormation drops it.
describe('ServiceDiscoveryProvider — Service property removal follows CloudFormation (#1160)', () => {
  let provider: ServiceDiscoveryProvider;
  const LIVE_HC = { Type: 'HTTP', ResourcePath: '/live', FailureThreshold: 4 };
  const LIVE_ARN = 'arn:aws:servicediscovery:us-east-1:111111111111:service/srv-1';
  const FULL = {
    Name: 'svc',
    NamespaceId: 'ns-abc',
    Description: 'template-desc',
    DnsConfig: { RoutingPolicy: 'WEIGHTED', DnsRecords: [{ Type: 'A', TTL: 120 }] },
    HealthCheckConfig: { Type: 'HTTP', ResourcePath: '/health', FailureThreshold: 3 },
  };
  const TYPE = 'AWS::ServiceDiscovery::Service';

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetServiceCommand) {
        return {
          Service: {
            Id: 'srv-1',
            Arn: LIVE_ARN,
            Description: 'live-desc',
            DnsConfig: { NamespaceId: 'ns-abc', RoutingPolicy: 'WEIGHTED', DnsRecords: [{ Type: 'A', TTL: 120 }] },
            HealthCheckConfig: LIVE_HC,
          },
        };
      }
      if (cmd instanceof UpdateServiceCommand) return { OperationId: 'op-1' };
      if (cmd instanceof GetOperationCommand) return { Operation: { Status: 'SUCCESS' } };
      return {};
    });
  });

  const updateCall = () => mockSend.mock.calls.find(([c]) => c instanceof UpdateServiceCommand);
  const sentChange = () => {
    const call = updateCall();
    expect(call).toBeDefined();
    return (call![0] as UpdateServiceCommand).input.Service!;
  };
  const getServiceCalls = () => mockSend.mock.calls.filter(([c]) => c instanceof GetServiceCommand).length;
  /** FULL minus `drop`, with `patch` merged over it. */
  const desired = (drop: (keyof typeof FULL)[], patch: Record<string, unknown> = {}) => {
    const copy: Record<string, unknown> = { ...FULL, ...patch };
    for (const key of drop) delete copy[key];
    return copy;
  };
  const ttl = (n: number) => ({ RoutingPolicy: 'WEIGHTED', DnsRecords: [{ Type: 'A', TTL: n }] });

  it.each([['Description'], ['HealthCheckConfig'], ['DnsConfig']] as const)(
    'removal-only (%s): no UpdateService, so the live value is kept',
    async (key) => {
      await provider.update('Svc', 'srv-1', TYPE, desired([key]), structuredClone(FULL));
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  // The state record is REDACTED while the desired bag is resolved, so a
  // recorded `{{resolve:` / `***` leaf counts as CHANGED: never dropping a
  // real template change. That is the fallback: a deploy passes the keys that
  // changed template to template (go-to-k/cdkd#5112, below).
  it.each([
    [
      'a secret reference swapped for another',
      '{{resolve:secretsmanager:svc-desc-a:SecretString:d}}',
      'plaintext-b',
    ],
    ['text around an unchanged reference changed', 'dev {{resolve:ssm-secure:/svc/x}}', 'prod s3cr3t'],
    ['a plain Description containing *** changed', 'a *** b', 'c *** d'],
  ])('a recorded stand-in leaf counts as changed, so the update is SENT: %s', async (_label, recorded, next) => {
    await provider.update('Svc', 'srv-1', TYPE, desired([], { Description: next }), {
      ...structuredClone(FULL),
      Description: recorded,
    });
    expect(sentChange().Description).toBe(next);
  });

  const STAND_INS = [
    ['a secret dynamic reference', '{{resolve:secretsmanager:svc-desc:SecretString:d}}'],
    ['a NoEcho mask', '***'],
  ] as const;

  // go-to-k/cdkd#5112: the provider half only. Given keys that leave out an
  // unchanged stand-in, it sends nothing. Which keys the ENGINE hands over (a
  // NoEcho `***` is left out only once AWS confirmed holding it) is pinned in
  // tests/unit/deployment/deploy-engine-changed-properties-5112.test.ts.
  it.each(STAND_INS)(
    'given changed keys leaving out an unchanged Description recorded as %s, a removed HealthCheckConfig beside it sends nothing, keeping the health check (CloudFormation parity)',
    async (_label, recorded) => {
      await provider.update(
        'Svc',
        'srv-1',
        TYPE,
        desired(['HealthCheckConfig'], { Description: 'resolved-plaintext' }),
        { ...structuredClone(FULL), Description: recorded },
        { changedProperties: new Set(['HealthCheckConfig']) }
      );
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(STAND_INS)(
    'with the engine changed keys, a Description recorded as %s that CHANGED is sent, clearing the removed health check as CloudFormation does',
    async (_label, recorded) => {
      await provider.update(
        'Svc',
        'srv-1',
        TYPE,
        desired(['HealthCheckConfig'], { Description: 'resolved-plaintext' }),
        { ...structuredClone(FULL), Description: recorded },
        { changedProperties: new Set(['Description', 'HealthCheckConfig']) }
      );
      const change = sentChange();
      expect(change.Description).toBe('resolved-plaintext');
      expect(Object.hasOwn(change, 'HealthCheckConfig')).toBe(false);
    }
  );

  it('with the engine changed keys, a DnsConfig left out of them sends no records even beside a recorded stand-in TTL', async () => {
    await provider.update(
      'Svc',
      'srv-1',
      TYPE,
      desired([], { DnsConfig: ttl(300) }),
      { ...structuredClone(FULL), DnsConfig: { RoutingPolicy: 'WEIGHTED', DnsRecords: [{ Type: 'A', TTL: '***' }] } },
      { changedProperties: new Set<string>() }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('with the engine changed keys naming DnsConfig, a records-only change is sent and keeps the live fields', async () => {
    await provider.update(
      'Svc',
      'srv-1',
      TYPE,
      desired(['Description', 'HealthCheckConfig'], { DnsConfig: ttl(300) }),
      structuredClone(FULL),
      { changedProperties: new Set(['Description', 'HealthCheckConfig', 'DnsConfig']) }
    );
    const change = sentChange();
    expect(change.DnsConfig?.DnsRecords).toEqual([{ Type: 'A', TTL: 300 }]);
    expect(change.Description).toBe('live-desc');
    expect(change.HealthCheckConfig).toEqual(LIVE_HC);
  });

  it.each(STAND_INS)(
    'with NO changed keys (a rollback revert, drift --revert), an unchanged Description recorded as %s still counts as changed: the fallback never drops a change',
    async (_label, recorded) => {
      await provider.update(
        'Svc',
        'srv-1',
        TYPE,
        desired(['HealthCheckConfig'], { Description: 'resolved-plaintext' }),
        { ...structuredClone(FULL), Description: recorded }
      );
      const change = sentChange();
      expect(change.Description).toBe('resolved-plaintext');
      expect(Object.hasOwn(change, 'HealthCheckConfig')).toBe(false);
    }
  );

  it('a recorded stand-in leaf inside HealthCheckConfig does not hide a change to a sibling leaf', async () => {
    const hc = { Type: 'HTTP', ResourcePath: '/resolved', FailureThreshold: 2 };
    await provider.update('Svc', 'srv-1', TYPE, desired([], { HealthCheckConfig: hc }), {
      ...FULL,
      HealthCheckConfig: { Type: 'HTTP', ResourcePath: '{{resolve:ssm:/svc/path}}', FailureThreshold: 3 },
    });
    expect(sentChange().HealthCheckConfig).toEqual(hc);
  });

  it('(a) Description removed + DnsRecords TTL changed: TTL is sent and the live Description kept', async () => {
    await provider.update('Svc', 'srv-1', TYPE, desired(['Description'], { DnsConfig: ttl(240) }), FULL);
    const change = sentChange();
    expect(change.DnsConfig).toEqual({ DnsRecords: [{ Type: 'A', TTL: 240 }] });
    expect(change.Description).toBe('live-desc');
    expect(change.HealthCheckConfig).toEqual(FULL.HealthCheckConfig);
  });

  it('DnsRecords-only change with HealthCheckConfig removed keeps the live HealthCheckConfig', async () => {
    await provider.update('Svc', 'srv-1', TYPE, desired(['HealthCheckConfig'], { DnsConfig: ttl(240) }), FULL);
    const change = sentChange();
    expect(change.HealthCheckConfig).toEqual(LIVE_HC);
    expect(change.Description).toBe('template-desc');
  });

  it("(a'') Description removed + HealthCheckConfig changed: the Description is cleared (omitted), no read-back", async () => {
    const hc = { Type: 'HTTP', ResourcePath: '/health', FailureThreshold: 2 };
    await provider.update('Svc', 'srv-1', TYPE, desired(['Description'], { HealthCheckConfig: hc }), FULL);
    const change = sentChange();
    expect(Object.hasOwn(change, 'Description')).toBe(false);
    expect(change.HealthCheckConfig).toEqual(hc);
    expect(getServiceCalls()).toBe(0);
  });

  it('(b) HealthCheckConfig removed + Description changed: the HealthCheckConfig is cleared (omitted)', async () => {
    await provider.update('Svc', 'srv-1', TYPE, desired(['HealthCheckConfig'], { Description: 'changed' }), FULL);
    const change = sentChange();
    expect(change.Description).toBe('changed');
    expect(Object.hasOwn(change, 'HealthCheckConfig')).toBe(false);
    expect(change.DnsConfig).toEqual({ DnsRecords: FULL.DnsConfig.DnsRecords });
    expect(getServiceCalls()).toBe(0);
  });

  it('(c) DnsConfig removed + Description changed: sent without DnsConfig, and the AWS refusal surfaces', async () => {
    const refusal = Object.assign(new Error('Service dns config cannot be null'), { name: 'InvalidInput' });
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof UpdateServiceCommand) throw refusal;
      return {};
    });
    const err = await provider
      .update('Svc', 'srv-1', TYPE, desired(['DnsConfig'], { Description: 'changed' }), FULL)
      .catch((e: unknown) => e);
    const change = (updateCall()![0] as UpdateServiceCommand).input.Service!;
    expect(Object.hasOwn(change, 'DnsConfig')).toBe(false);
    expect(change.Description).toBe('changed');
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as ProvisioningError).message).toContain('Service dns config cannot be null');
    expect(getServiceCalls()).toBe(0);
  });

  it('(d) HTTP service: Description removed + ServiceAttributes changed sends no UpdateService', async () => {
    const prev = { Name: 'svc', NamespaceId: 'ns-http', Description: 'template-desc', ServiceAttributes: { k: 'v1' } };
    await provider.update('Svc', 'srv-1', TYPE, { Name: 'svc', NamespaceId: 'ns-http', ServiceAttributes: { k: 'v2' } }, prev);
    expect(updateCall()).toBeUndefined();
    expect(mockSend.mock.calls.some(([c]) => c instanceof UpdateServiceAttributesCommand)).toBe(true);
  });

  it('a declared but unchanged bag sends no UpdateService (a Tags-only change)', async () => {
    await provider.update('Svc', 'srv-1', TYPE, desired([], { Tags: [{ Key: 'k', Value: 'v' }] }), structuredClone(FULL));
    expect(updateCall()).toBeUndefined();
    const tag = mockSend.mock.calls.find(([c]) => c instanceof TagResourceCommand);
    expect((tag![0] as TagResourceCommand).input.ResourceARN).toBe(LIVE_ARN);
  });

  it('the DnsRecords-only arm spends no GetService when Description and HealthCheckConfig are both declared', async () => {
    await provider.update('Svc', 'srv-1', TYPE, desired([], { DnsConfig: ttl(240) }), FULL);
    expect(sentChange().Description).toBe('template-desc');
    expect(getServiceCalls()).toBe(0);
  });

  it('a live service without the removed field echoes nothing for it on the DnsRecords-only arm', async () => {
    mockSend.mockImplementationOnce(async () => ({ Service: { Id: 'srv-1' } }));
    await provider.update('Svc', 'srv-1', TYPE, desired(['Description'], { DnsConfig: ttl(240) }), FULL);
    expect(Object.hasOwn(sentChange(), 'Description')).toBe(false);
  });

  it('a failed GetService read-back sends no UpdateService and throws a wrapped error carrying the cause', async () => {
    const boom = new Error('throttled');
    mockSend.mockImplementationOnce(async () => {
      throw boom;
    });
    const err = await provider
      .update('Svc', 'srv-1', TYPE, desired(['Description'], { DnsConfig: ttl(240) }), FULL)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as ProvisioningError).message).toContain('Failed to update service discovery service Svc');
    expect((err as ProvisioningError).cause).toBe(boom);
    expect(updateCall()).toBeUndefined();
  });

  it('a Tags change on the DnsRecords-only arm reuses the read-back ARN instead of a second GetService', async () => {
    await provider.update(
      'Svc',
      'srv-1',
      TYPE,
      desired(['Description'], { DnsConfig: ttl(240), Tags: [{ Key: 'k', Value: 'v' }] }),
      FULL
    );
    expect(getServiceCalls()).toBe(1);
    const tag = mockSend.mock.calls.find(([c]) => c instanceof TagResourceCommand);
    expect((tag![0] as TagResourceCommand).input.ResourceARN).toBe(LIVE_ARN);
  });

  it('declares every handled Service property removal-handled, so no unhandled-removal warning fires', () => {
    const handled = provider.handledProperties.get(TYPE)!;
    const declared = provider.removalHandledInUpdate.get(TYPE)!;
    expect([...handled].filter((k) => !declared.has(k))).toEqual([]);
    expect(provider.removalDefaults.has(TYPE)).toBe(false);
  });
});

// go-to-k/cdkd#5348: CloudFormation generates a name the template omits; the
// provider used to refuse the create before any call.
describe('ServiceDiscoveryProvider — Service without a Name (#5348)', () => {
  const TYPE = 'AWS::ServiceDiscovery::Service';
  const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  let provider: ServiceDiscoveryProvider;
  const createdName = (): unknown =>
    (
      mockSend.mock.calls.find(([c]) => c instanceof CreateServiceCommand)?.[0] as
        | CreateServiceCommand
        | undefined
    )?.input.Name;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
    mockSend.mockResolvedValue({
      Service: { Id: 'srv-1', Arn: 'arn:aws:servicediscovery:us-east-1:0:service/srv-1' },
    });
  });

  it.each([
    ['no Name', {}],
    ['an empty Name', { Name: '' }],
  ])('%s: sends the generated name and records it', async (_label, extra) => {
    const result = await withStackScope(
      { stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() },
      () => provider.create('MyService', TYPE, { NamespaceId: 'ns-1', ...extra })
    );

    const sent = createdName();
    expect(sent).toMatch(/^MyStack-MyService-[0-9a-f]{12}$/);
    expect(sent).toBe(
      withStackScope(
        { stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() },
        () => generatedNameFor(TYPE, 'MyService')
      )
    );
    expect(result.physicalId).toBe('srv-1');
    expect(result.attributes?.['Name']).toBe(sent);
  });

  it('on a legacy stack (no instance id): the stack-prefixed name', async () => {
    await withStackScope(
      { stackName: 'MyStack', stackInstanceId: undefined, nameGenerations: undefined },
      () => provider.create('MyService', TYPE, { NamespaceId: 'ns-1' })
    );

    expect(createdName()).toBe('MyStack-MyService');
  });

  it('a long stack name still yields one DNS label of at most 63 characters', async () => {
    await withStackScope(
      { stackName: `S${'x'.repeat(120)}`, stackInstanceId: ID, nameGenerations: new Map() },
      () => provider.create('MyService', TYPE, { NamespaceId: 'ns-1' })
    );

    const sent = createdName() as string;
    expect(sent.length).toBeLessThanOrEqual(63);
    expect(sent).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_]$/);
  });

  it('a declared name is sent as is', async () => {
    await withStackScope(
      { stackName: 'MyStack', stackInstanceId: ID, nameGenerations: new Map() },
      () => provider.create('MyService', TYPE, { Name: 'declared', NamespaceId: 'ns-1' })
    );

    expect(createdName()).toBe('declared');
  });
});

// go-to-k/cdkd#5373: `UpdateService`'s `DnsConfigChange` has no member for
// `DnsConfig.NamespaceId` or `DnsConfig.RoutingPolicy`. CloudFormation, measured
// in us-east-1, leaves both as they are and reports UPDATE_COMPLETE (no
// replacement, no failure); cdkd matches that outcome and names them in a
// warning instead of staying silent, once the live service confirms the
// difference.
describe('ServiceDiscoveryProvider — unapplied DnsConfig members are named (#5373)', () => {
  const TYPE = 'AWS::ServiceDiscovery::Service';
  const BASE = {
    Name: 'svc',
    Description: 'desc',
    DnsConfig: {
      NamespaceId: 'ns-a',
      RoutingPolicy: 'MULTIVALUE',
      DnsRecords: [{ Type: 'A', TTL: 60 }],
    },
  };
  let provider: ServiceDiscoveryProvider;
  const warn = () => getLogger().child('x').warn as ReturnType<typeof vi.fn>;
  const warnings = () => warn().mock.calls.map(([m]) => String(m));
  const dns = (patch: Record<string, unknown>) => ({ ...BASE, DnsConfig: { ...BASE.DnsConfig, ...patch } });
  const sentChange = () =>
    (mockSend.mock.calls.find(([c]) => c instanceof UpdateServiceCommand)?.[0] as UpdateServiceCommand | undefined)
      ?.input.Service;

  /** What AWS holds: the BASE values, never changed by an update. */
  let live: Record<string, unknown> | Error;
  const nonReads = () => mockSend.mock.calls.filter(([c]) => !(c instanceof GetServiceCommand));

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
    live = { Id: 'srv-1', NamespaceId: 'ns-a', DnsConfig: { ...BASE.DnsConfig } };
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof UpdateServiceCommand) return { OperationId: 'op-1' };
      if (cmd instanceof GetOperationCommand) return { Operation: { Status: 'SUCCESS' } };
      if (cmd instanceof GetServiceCommand) {
        if (live instanceof Error) throw live;
        return { Service: live };
      }
      return {};
    });
  });

  it('a RoutingPolicy change on its own sends nothing and names the member, pointing at a new Name', async () => {
    await provider.update('Svc', 'srv-1', TYPE, dns({ RoutingPolicy: 'WEIGHTED' }), structuredClone(BASE));
    expect(nonReads()).toEqual([]);
    expect(warnings()).toEqual([
      'Svc (AWS::ServiceDiscovery::Service): DnsConfig.RoutingPolicy changed, but Cloud Map cannot change it on an existing service, so the service keeps its current value, as CloudFormation does. To change it, replace the service, for example by giving it a new Name.',
    ]);
  });

  it('a DnsConfig.NamespaceId change on its own sends nothing and points at the top-level NamespaceId', async () => {
    await provider.update('Svc', 'srv-1', TYPE, dns({ NamespaceId: 'ns-b' }), structuredClone(BASE));
    expect(nonReads()).toEqual([]);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('DnsConfig.NamespaceId changed');
    expect(warnings()[0]).toContain('declare the namespace in the top-level NamespaceId');
  });

  it('both beside a TTL change: the records are sent without either member, and both are named in one warning', async () => {
    await provider.update(
      'Svc',
      'srv-1',
      TYPE,
      dns({ NamespaceId: 'ns-b', RoutingPolicy: 'WEIGHTED', DnsRecords: [{ Type: 'A', TTL: 90 }] }),
      structuredClone(BASE)
    );
    expect(sentChange()?.DnsConfig).toStrictEqual({ DnsRecords: [{ Type: 'A', TTL: 90 }] });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(
      'DnsConfig.NamespaceId and DnsConfig.RoutingPolicy changed, but Cloud Map cannot change them on an existing service, so the service keeps its current values'
    );
  });

  it('beside a Description change: the Description is sent and the member is named', async () => {
    await provider.update(
      'Svc',
      'srv-1',
      TYPE,
      { ...dns({ RoutingPolicy: 'WEIGHTED' }), Description: 'changed' },
      structuredClone(BASE)
    );
    expect(sentChange()?.Description).toBe('changed');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('DnsConfig.RoutingPolicy changed');
  });

  it.each([
    ['an added member', { ...BASE, DnsConfig: { DnsRecords: BASE.DnsConfig.DnsRecords } }, BASE, 'NamespaceId'],
    ['a removed member', BASE, { ...BASE, DnsConfig: { DnsRecords: BASE.DnsConfig.DnsRecords } }, 'NamespaceId'],
  ])('%s counts as a change while AWS holds another value', async (_label, previous, next, member) => {
    live = { Id: 'srv-1', NamespaceId: 'ns-z', DnsConfig: { ...BASE.DnsConfig, RoutingPolicy: 'WEIGHTED' } };
    await provider.update('Svc', 'srv-1', TYPE, structuredClone(next), structuredClone(previous));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(`DnsConfig.${member} and DnsConfig.RoutingPolicy changed`);
  });

  it.each([
    ['nothing changed', () => provider.update('Svc', 'srv-1', TYPE, structuredClone(BASE), structuredClone(BASE))],
    [
      'only the records changed',
      () =>
        provider.update('Svc', 'srv-1', TYPE, dns({ DnsRecords: [{ Type: 'A', TTL: 90 }] }), structuredClone(BASE)),
    ],
    [
      'DnsConfig removed whole (the #1160 removal path)',
      () => provider.update('Svc', 'srv-1', TYPE, { Name: 'svc', Description: 'desc' }, structuredClone(BASE)),
    ],
    [
      'the engine says DnsConfig did not change template to template',
      () =>
        provider.update('Svc', 'srv-1', TYPE, dns({ RoutingPolicy: 'WEIGHTED' }), structuredClone(BASE), {
          changedProperties: new Set(['Description']),
        }),
    ],
  ])('no warning when %s', async (_label, run) => {
    await run();
    expect(warn()).not.toHaveBeenCalled();
  });

  // The state records the declared value, never applied, so the template-to-
  // state difference alone is not enough: AWS must still hold another value.
  it.each([
    [
      'a rollback (or a reverted template) going back to what AWS holds',
      () => provider.update('Svc', 'srv-1', TYPE, structuredClone(BASE), dns({ NamespaceId: 'ns-b', RoutingPolicy: 'WEIGHTED' })),
    ],
    [
      'a member added at the value AWS already holds',
      () =>
        provider.update('Svc', 'srv-1', TYPE, structuredClone(BASE), {
          ...BASE,
          DnsConfig: { DnsRecords: BASE.DnsConfig.DnsRecords },
        }),
    ],
    [
      'a recorded stand-in on the previous side, with the declared value live',
      () =>
        provider.update('Svc', 'srv-1', TYPE, structuredClone(BASE), {
          ...BASE,
          DnsConfig: { ...BASE.DnsConfig, NamespaceId: '{{resolve:ssm:/ns-id}}' },
        }),
    ],
  ])('no warning for %s', async (_label, run) => {
    await run();
    expect(warn()).not.toHaveBeenCalled();
  });

  it('confirms against the top-level NamespaceId when DnsConfig declares none', async () => {
    await provider.update(
      'Svc',
      'srv-1',
      TYPE,
      { ...BASE, NamespaceId: 'ns-a', DnsConfig: { DnsRecords: BASE.DnsConfig.DnsRecords, RoutingPolicy: 'MULTIVALUE' } },
      structuredClone(BASE),
      { changedProperties: new Set(['DnsConfig', 'NamespaceId']) }
    );
    expect(warn()).not.toHaveBeenCalled();
  });

  it('only the member AWS does not hold is named', async () => {
    live = { Id: 'srv-1', NamespaceId: 'ns-a', DnsConfig: { ...BASE.DnsConfig, RoutingPolicy: 'WEIGHTED' } };
    await provider.update(
      'Svc',
      'srv-1',
      TYPE,
      dns({ NamespaceId: 'ns-b', RoutingPolicy: 'WEIGHTED' }),
      structuredClone(BASE)
    );
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('DnsConfig.NamespaceId changed, but Cloud Map cannot change it');
  });

  it('a failed read-back keeps the warning, and the update still succeeds', async () => {
    live = new Error('throttled');
    const result = await provider.update('Svc', 'srv-1', TYPE, dns({ RoutingPolicy: 'WEIGHTED' }), structuredClone(BASE));
    expect(result).toEqual({ physicalId: 'srv-1', wasReplaced: false });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('DnsConfig.RoutingPolicy changed');
  });

  it('a failed UpdateService names nothing: the warning follows a successful update only', async () => {
    mockSend.mockImplementation(async () => {
      throw new Error('boom');
    });
    await expect(
      provider.update(
        'Svc',
        'srv-1',
        TYPE,
        { ...dns({ RoutingPolicy: 'WEIGHTED' }), Description: 'changed' },
        structuredClone(BASE)
      )
    ).rejects.toBeInstanceOf(ProvisioningError);
    expect(warn()).not.toHaveBeenCalled();
  });
});
