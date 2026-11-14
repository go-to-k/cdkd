import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6242: `Fn::GetAtt [WebACL, Capacity]` — the web ACL's WCUs, a
// NUMBER (real CloudFormation answered `0` for a rule-less web ACL,
// 2026-11-14) — is recorded from `GetWebACL` on create, update and import.

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-wafv2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-wafv2');
  return {
    ...actual,
    WAFV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';

const ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123';
const ID = 'abc-123';
const TYPE = 'AWS::WAFv2::WebACL';
const RULE = {
  Name: 'r1',
  Priority: 0,
  Action: { Block: {} },
  Statement: { GeoMatchStatement: { CountryCodes: ['US'] } },
  VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'r1' },
};
const props = (rules: unknown[], extra: Record<string, unknown> = {}) => ({
  Name: 'my-acl',
  Scope: 'REGIONAL',
  DefaultAction: { Allow: {} },
  VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'm' },
  Rules: rules,
  ...extra,
});
const names = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);

describe('WAFv2 WebACL Capacity (#6242)', () => {
  let provider: WAFv2WebACLProvider;
  beforeEach(() => {
    mockSend.mockReset();
    provider = new WAFv2WebACLProvider();
  });

  it('create records Capacity as a number from the GetWebACL it already makes', async () => {
    mockSend.mockResolvedValueOnce({ Summary: { ARN, Id: ID } });
    mockSend.mockResolvedValueOnce({ WebACL: { LabelNamespace: 'awswaf:1:webacl:my-acl:', Capacity: 0 } });
    const result = await provider.create('Acl', TYPE, props([]));
    expect(result.attributes).toStrictEqual({
      Arn: ARN,
      Id: ID,
      LabelNamespace: 'awswaf:1:webacl:my-acl:',
      Capacity: 0,
    });
    expect(names()).toStrictEqual(['CreateWebACLCommand', 'GetWebACLCommand']);
  });

  it('create whose read-back fails leaves Capacity absent', async () => {
    mockSend.mockResolvedValueOnce({ Summary: { ARN, Id: ID } });
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const result = await provider.create('Acl', TYPE, props([]));
    expect(result.attributes).toStrictEqual({ Arn: ARN, Id: ID });
  });

  it('an update that leaves Rules alone serves the pre-update read, with no extra call', async () => {
    mockSend.mockResolvedValueOnce({ LockToken: 't', WebACL: { LabelNamespace: 'ns', Capacity: 1 } });
    mockSend.mockResolvedValueOnce({ NextLockToken: 't2' });
    const result = await provider.update(
      'Acl',
      ARN,
      TYPE,
      props([RULE], { Description: 'new' }),
      props([RULE], { Description: 'old' })
    );
    expect(result.attributes).toStrictEqual({ Arn: ARN, Id: ID, LabelNamespace: 'ns', Capacity: 1 });
    expect(names()).toStrictEqual(['GetWebACLCommand', 'UpdateWebACLCommand']);
  });

  it('an update that changes Rules re-reads Capacity after UpdateWebACL', async () => {
    mockSend.mockResolvedValueOnce({ LockToken: 't', WebACL: { LabelNamespace: 'ns', Capacity: 0 } });
    mockSend.mockResolvedValueOnce({ NextLockToken: 't2' });
    mockSend.mockResolvedValueOnce({ WebACL: { LabelNamespace: 'ns', Capacity: 1 } });
    const result = await provider.update('Acl', ARN, TYPE, props([RULE]), props([]));
    expect(result.attributes?.['Capacity']).toBe(1);
    expect(names()).toStrictEqual(['GetWebACLCommand', 'UpdateWebACLCommand', 'GetWebACLCommand']);
  });

  it('a failed re-read after a Rules change drops the stale Capacity, keeps the rest', async () => {
    mockSend.mockResolvedValueOnce({ LockToken: 't', WebACL: { LabelNamespace: 'ns', Capacity: 0 } });
    mockSend.mockResolvedValueOnce({ NextLockToken: 't2' });
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const result = await provider.update('Acl', ARN, TYPE, props([RULE]), props([]));
    expect(result.attributes).toStrictEqual({ Arn: ARN, Id: ID, LabelNamespace: 'ns' });
  });

  it('import records Capacity from GetWebACL', async () => {
    mockSend.mockResolvedValueOnce({ WebACL: { ARN, Id: ID, LabelNamespace: 'ns', Capacity: 7 } });
    const result = await provider.import({
      logicalId: 'Acl',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: ARN,
    });
    expect(result?.attributes).toStrictEqual({ Arn: ARN, Id: ID, LabelNamespace: 'ns', Capacity: 7 });
  });
});
