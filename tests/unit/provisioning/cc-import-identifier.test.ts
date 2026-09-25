/**
 * `cdkd import` completes a bare CloudFormation physical id to the Cloud Control
 * identifier for a type whose primary identifier is COMPOSITE (issue
 * [#3672](https://github.com/go-to-k/cdkd/issues/3672)).
 *
 * The provider cases assert the `Identifier` actually SENT to `GetResource` and
 * the `physicalId` RECORDED — the two values the bug got wrong — rather than
 * only the helper's return, so a provider that computed the identifier and then
 * kept sending `knownPhysicalId` would still fail here.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockCloudFormationSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCloudControlSend, config: { region: vi.fn() } },
    cloudFormation: { send: mockCloudFormationSend },
    dynamoDB: { send: vi.fn() },
    apiGateway: { send: vi.fn() },
    cloudFront: { send: vi.fn() },
    lambda: { send: vi.fn() },
    eventBridge: { send: vi.fn() },
  }),
}));

const { mockWarn, mockDebug } = vi.hoisted(() => ({ mockWarn: vi.fn(), mockDebug: vi.fn() }));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: mockDebug,
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    child: vi.fn(() => child),
  };
  return {
    getLogger: () => ({ ...child, child: () => child }),
  };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import {
  clearPrimaryIdentifierCache,
  getPrimaryIdentifierFields,
  toCloudControlIdentifier,
} from '../../../src/provisioning/cc-import-identifier.js';
import { clearReadOnlyPropertiesCache } from '../../../src/provisioning/read-only-properties.js';
import { describeTypeRetryDelays } from '../../../src/provisioning/describe-type.js';

const CIDR_TYPE = 'AWS::EC2::VPCCidrBlock';
const ASSOC_ID = 'vpc-cidr-assoc-0123456789abcdef0';
const VPC_ID = 'vpc-0abc1234def567890';

/** The live registry schema's shape for the fields this path reads. */
const CIDR_SCHEMA = JSON.stringify({
  primaryIdentifier: ['/properties/Id', '/properties/VpcId'],
  readOnlyProperties: ['/properties/Id', '/properties/Ipv6CidrBlock'],
});

function wireGetResource(): void {
  mockCloudControlSend.mockImplementation(
    (cmd: { constructor: { name: string }; input: { Identifier?: string } }) => {
      if (cmd.constructor.name === 'GetResourceCommand') {
        return Promise.resolve({
          ResourceDescription: {
            Identifier: cmd.input.Identifier,
            Properties: JSON.stringify({ Id: ASSOC_ID, VpcId: VPC_ID }),
          },
        });
      }
      return Promise.reject(new Error(`unexpected command ${cmd.constructor.name}`));
    }
  );
}

function sentIdentifiers(): unknown[] {
  return mockCloudControlSend.mock.calls
    .filter((c) => (c[0] as { constructor: { name: string } }).constructor.name === 'GetResourceCommand')
    .map((c) => (c[0] as { input: { Identifier?: unknown } }).input.Identifier);
}

describe('CloudControlProvider.import composite identifier (issue #3672)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPrimaryIdentifierCache();
    clearReadOnlyPropertiesCache();
    describeTypeRetryDelays.sleep = async () => {};
  });

  it("completes CloudFormation's bare VPCCidrBlock id with the template's VpcId, and records the composite", async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: CIDR_SCHEMA });
    wireGetResource();

    const result = await new CloudControlProvider().import({
      logicalId: 'VpcIpv6Cidr',
      resourceType: CIDR_TYPE,
      stackName: 'S',
      region: 'us-east-1',
      // What `cdkd import` hands over after its Ref pre-substitution.
      properties: { VpcId: VPC_ID, AmazonProvidedIpv6CidrBlock: true },
      knownPhysicalId: ASSOC_ID,
    });

    expect(sentIdentifiers()).toEqual([`${ASSOC_ID}|${VPC_ID}`]);
    expect(result?.physicalId).toBe(`${ASSOC_ID}|${VPC_ID}`);
    expect(result?.attributes).toMatchObject({ Id: ASSOC_ID });
  });

  it('passes an id that already carries the full composite through unchanged', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: CIDR_SCHEMA });
    wireGetResource();

    const result = await new CloudControlProvider().import({
      logicalId: 'VpcIpv6Cidr',
      resourceType: CIDR_TYPE,
      stackName: 'S',
      region: 'us-east-1',
      // A DIFFERENT template VpcId proves the supplied composite is not rebuilt.
      properties: { VpcId: 'vpc-0ffffffffffffffff' },
      knownPhysicalId: `${ASSOC_ID}|${VPC_ID}`,
    });

    expect(sentIdentifiers()).toEqual([`${ASSOC_ID}|${VPC_ID}`]);
    expect(result?.physicalId).toBe(`${ASSOC_ID}|${VPC_ID}`);
  });

  it('passes the id through unchanged when the schema cannot be read (the pre-#3672 behaviour)', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    wireGetResource();

    const result = await new CloudControlProvider().import({
      logicalId: 'VpcIpv6Cidr',
      resourceType: CIDR_TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: { VpcId: VPC_ID },
      knownPhysicalId: ASSOC_ID,
    });

    expect(sentIdentifiers()).toEqual([ASSOC_ID]);
    expect(result?.physicalId).toBe(ASSOC_ID);
  });

  it('refuses, without calling GetResource, when the template cannot supply the other field', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: CIDR_SCHEMA });
    wireGetResource();

    await expect(
      new CloudControlProvider().import({
        logicalId: 'VpcIpv6Cidr',
        resourceType: CIDR_TYPE,
        stackName: 'S',
        region: 'us-east-1',
        // An unsubstituted Ref: the VPC's id is not known.
        properties: { VpcId: { Ref: 'Vpc' } },
        knownPhysicalId: ASSOC_ID,
      })
    ).rejects.toThrow("--resource 'VpcIpv6Cidr=<Id>|<VpcId>'");
    expect(sentIdentifiers()).toEqual([]);
  });
});

describe('getPrimaryIdentifierFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPrimaryIdentifierCache();
    describeTypeRetryDelays.sleep = async () => {};
  });

  it('returns the fields in SCHEMA order, which is the order Cloud Control joins them in', async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ primaryIdentifier: ['/properties/VpcId', '/properties/Id'] }),
    });
    expect(await getPrimaryIdentifierFields(CIDR_TYPE)).toEqual(['VpcId', 'Id']);
  });

  it('returns undefined for a nested pointer, which no template property maps onto', async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ primaryIdentifier: ['/properties/A/B', '/properties/C'] }),
    });
    expect(await getPrimaryIdentifierFields('AWS::X::Y')).toBeUndefined();
  });

  it('does not cache a failed lookup', async () => {
    mockCloudFormationSend.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await getPrimaryIdentifierFields(CIDR_TYPE)).toBeUndefined();
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: CIDR_SCHEMA });
    expect(await getPrimaryIdentifierFields(CIDR_TYPE)).toEqual(['Id', 'VpcId']);
  });

  it('caches a successful lookup: a second call issues no DescribeType', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: CIDR_SCHEMA });
    expect(await getPrimaryIdentifierFields(CIDR_TYPE)).toEqual(['Id', 'VpcId']);
    expect(await getPrimaryIdentifierFields(CIDR_TYPE)).toEqual(['Id', 'VpcId']);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('skips DescribeType for a type with no registry schema', async () => {
    expect(await getPrimaryIdentifierFields('Custom::Thing')).toBeUndefined();
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
  });
});

describe('toCloudControlIdentifier', () => {
  const base = {
    resourceType: 'AWS::X::Y',
    logicalId: 'Res',
    fields: ['A', 'B', 'C'] as const,
  };

  it('fills the one field the template does not supply, in schema position', () => {
    expect(
      toCloudControlIdentifier({ ...base, physicalId: 'id-b', properties: { A: 'a', C: 'c' } })
    ).toBe('a|id-b|c');
  });

  it('uses the template composite when the template supplies every field, noting at DEBUG that the supplied id is set aside', () => {
    mockWarn.mockClear();
    mockDebug.mockClear();
    expect(
      toCloudControlIdentifier({
        ...base,
        physicalId: 'cfn-generated-name',
        properties: { A: 'a', B: 'b', C: 'c' },
      })
    ).toBe('a|b|c');
    // Expected on every ordinary migration of such a type, so never a warning.
    expect(mockWarn).not.toHaveBeenCalled();
    const noted = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("the supplied id 'cfn-generated-name' is not used"));
    expect(noted).toHaveLength(1);
  });

  it('does not note a set-aside id when the supplied id is one of the template values', () => {
    mockDebug.mockClear();
    expect(
      toCloudControlIdentifier({ ...base, physicalId: 'b', properties: { A: 'a', B: 'b', C: 'c' } })
    ).toBe('a|b|c');
    const noted = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('is not used'));
    expect(noted).toHaveLength(0);
  });

  it('reads a numeric or boolean template value as its string form', () => {
    expect(
      toCloudControlIdentifier({
        ...base,
        physicalId: 'acl-1',
        properties: { B: 100, C: false },
      })
    ).toBe('acl-1|100|false');
  });

  it('passes a single-field id carrying a pipe through, rather than refusing its arity', () => {
    // A single-field type's id may legitimately contain `|` (CloudFormation
    // spells a custom-bus `AWS::Events::Rule` as `<bus>|<rule>`); only a
    // COMPOSITE type's arity is checked.
    expect(
      toCloudControlIdentifier({ ...base, fields: ['A'], physicalId: 'bus|rule', properties: { A: 'a' } })
    ).toBe('bus|rule');
  });

  it('passes a single-field type through', () => {
    expect(
      // `A` present in the template: a single-field type must NOT be completed
      // from it, so the supplied id wins.
      toCloudControlIdentifier({ ...base, fields: ['A'], physicalId: 'x', properties: { A: 'a' } })
    ).toBe('x');
  });

  it("passes Cloud Control's JSON identifier form through", () => {
    const json = '{"A":"a","B":"b","C":"c"}';
    expect(toCloudControlIdentifier({ ...base, physicalId: json, properties: {} })).toBe(json);
  });

  it('refuses when two or more fields are unknown', () => {
    expect(() =>
      toCloudControlIdentifier({ ...base, physicalId: 'x', properties: { A: 'a' } })
    ).toThrow('no literal value for B or C');
  });

  it('treats a non-string or blank template value as unknown', () => {
    expect(() =>
      toCloudControlIdentifier({
        ...base,
        physicalId: 'x',
        properties: { A: { 'Fn::GetAtt': ['P', 'Id'] }, B: ' ', C: 'c' },
      })
    ).toThrow('no literal value for A or B');
  });

  it('refuses a supplied id equal to a value the template gives another field', () => {
    expect(() =>
      toCloudControlIdentifier({ ...base, physicalId: 'a', properties: { A: 'a', C: 'c' } })
    ).toThrow('cannot be told which field it is');
  });

  it('refuses a composite of the wrong arity', () => {
    expect(() =>
      toCloudControlIdentifier({ ...base, physicalId: 'a|b', properties: {} })
    ).toThrow("has 2 '|'-separated segments");
  });

  it('refuses a template value carrying the separator', () => {
    expect(() =>
      toCloudControlIdentifier({ ...base, physicalId: 'id-b', properties: { A: 'x|y', C: 'c' } })
    ).toThrow("contains '|'");
  });

  it('does not read an inherited property as a template value', () => {
    const properties = Object.create({ A: 'inherited' }) as Record<string, unknown>;
    properties['C'] = 'c';
    expect(() => toCloudControlIdentifier({ ...base, physicalId: 'x', properties })).toThrow(
      'no literal value for A or B'
    );
  });
});
