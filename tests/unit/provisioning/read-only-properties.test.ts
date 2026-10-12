/**
 * `getTopLevelReadOnlyProperties` — the schema-backed attribute resolver behind
 * `CloudControlProvider.import`'s narrowing (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847)).
 *
 * The ONE property that separates this module from its `write-only-properties.ts`
 * sibling, and therefore the one every case here is built around: an
 * unresolvable schema must answer `undefined` ("cdkd could not find out") and
 * NOT the empty set ("this type has no attributes"). The sibling collapses those
 * two into one `Set` because its caller degrades safely either way; this
 * caller's fail-closed arm is only writable because the two stay distinguishable.
 * A regression that made failure return `new Set()` would be invisible to any
 * assertion phrased as "the result is empty" — so every failure case asserts
 * `toBeUndefined()` and every success case asserts a SET, never a truthiness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockCloudFormationSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import {
  getTopLevelAttributeNames,
  getTopLevelDeployAttributeNames,
  getTopLevelReadOnlyProperties,
  clearReadOnlyPropertiesCache,
} from '../../../src/provisioning/read-only-properties.js';
import { WRITABLE_GETATT_ATTRIBUTES } from '../../../src/provisioning/getatt-attributes.generated.js';
import { describeTypeRetryDelays } from '../../../src/provisioning/describe-type.js';

function throttlingError(): Error {
  const error = new Error('Rate exceeded');
  error.name = 'Throttling';
  return error;
}

// A REAL shape, taken from AWS's published bundle for this type: a flat
// attribute, and a nested pointer that must reduce to its CONTAINER.
const RDS_CLUSTER_SCHEMA = JSON.stringify({
  readOnlyProperties: [
    '/properties/DBClusterArn',
    '/properties/Endpoint/Address',
    '/properties/Endpoint/Port',
  ],
});

describe('getTopLevelReadOnlyProperties (issue #2847)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearReadOnlyPropertiesCache();
    describeTypeRetryDelays.sleep = async () => {};
  });

  afterEach(() => {
    delete describeTypeRetryDelays.sleep;
  });

  it('reduces a nested pointer to its CONTAINING property, so the resolver nested walk still has an object to descend', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: RDS_CLUSTER_SCHEMA });

    const result = await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster');

    // `Endpoint`, NOT `Address` / `Port`: reducing to the LEAF would drop the
    // container and break `Fn::GetAtt Endpoint.Port` (issue #381), which is the
    // reason this module copies the sibling's top-level convention rather than
    // keeping full paths.
    expect(result).toEqual(new Set(['DBClusterArn', 'Endpoint']));
  });

  it('answers undefined — NOT an empty set — when DescribeType keeps failing', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));

    const result = await getTopLevelReadOnlyProperties('AWS::Example::Thing');

    // The discriminator. `toBeUndefined` rather than a size/emptiness check:
    // an empty Set is the answer this module must NOT give here, and every
    // emptiness-shaped assertion would accept it.
    expect(result).toBeUndefined();
  });

  it('answers undefined for a type with no registry schema, without spending a DescribeType call', async () => {
    const result = await getTopLevelReadOnlyProperties('Custom::MyThing');

    expect(result).toBeUndefined();
    expect(mockCloudFormationSend).not.toHaveBeenCalled();
  });

  it('answers an EMPTY SET for a type whose schema declares no readOnlyProperties — a successful lookup, distinct from a failure', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: JSON.stringify({}) });

    const result = await getTopLevelReadOnlyProperties('AWS::Example::NoAttrs');

    // The other side of the same distinction: this one really is "no
    // attributes", and it must NOT come back as `undefined` or the caller
    // would emit its missing-permission warning for a healthy type.
    expect(result).toEqual(new Set());
  });

  it('answers an EMPTY SET when DescribeType returns no Schema at all — a successful lookup, not a failure', async () => {
    // A still-registering / publisher type answers with no `Schema`. The module
    // header calls that a SUCCESSFUL lookup of "no attributes"; nothing fenced
    // it, so a mutation to the fail-closed reading stayed green while silently
    // making every such type mask its whole model.
    mockCloudFormationSend.mockResolvedValueOnce({});

    expect(await getTopLevelReadOnlyProperties('AWS::Example::NoSchema')).toEqual(new Set());
  });

  it('unescapes RFC 6901 pointer segments (~1 -> /, ~0 -> ~)', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({
      Schema: JSON.stringify({
        readOnlyProperties: ['/properties/a~1b', '/properties/c~0d'],
      }),
    });

    expect(await getTopLevelReadOnlyProperties('AWS::Example::Escaped')).toEqual(
      new Set(['a/b', 'c~d'])
    );
  });

  it('ignores malformed readOnlyProperties entries rather than throwing or admitting them', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({
      Schema: JSON.stringify({
        readOnlyProperties: [
          '/properties/Good',
          42, // not a string
          '/definitions/NotAProperty', // not a /properties pointer
          '/properties/', // empty segment
        ],
      }),
    });

    expect(await getTopLevelReadOnlyProperties('AWS::Example::Messy')).toEqual(new Set(['Good']));
  });

  it('treats a non-array readOnlyProperties as no attributes rather than failing', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({
      Schema: JSON.stringify({ readOnlyProperties: 'Arn' }),
    });

    expect(await getTopLevelReadOnlyProperties('AWS::Example::Weird')).toEqual(new Set());
  });

  it('hands a CONCURRENT second caller the safe answer, not a rejection, while a lookup is failing', async () => {
    // The contract is "never throws". An earlier revision cached the RAW
    // promise and recovered only the calling side, so a second caller arriving
    // inside the failure window received a rejection out of that function.
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));

    const [first, second] = await Promise.all([
      getTopLevelReadOnlyProperties('AWS::Example::Concurrent'),
      getTopLevelReadOnlyProperties('AWS::Example::Concurrent'),
    ]);

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
  });

  it('rides out a transient throttle rather than reporting an unresolvable schema', async () => {
    mockCloudFormationSend
      .mockRejectedValueOnce(throttlingError())
      .mockResolvedValueOnce({ Schema: RDS_CLUSTER_SCHEMA });

    const result = await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster');

    expect(result).toEqual(new Set(['DBClusterArn', 'Endpoint']));
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache a THROTTLED failure: a later call retries and can succeed', async () => {
    // Every attempt throttled, so the retries are exhausted.
    mockCloudFormationSend.mockRejectedValue(throttlingError());
    expect(await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster')).toBeUndefined();

    mockCloudFormationSend.mockReset();
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: RDS_CLUSTER_SCHEMA });

    // A cached failure would keep answering `undefined` here, which for the
    // caller means "mask everything" forever after one transient throttle.
    expect(await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster')).toEqual(
      new Set(['DBClusterArn', 'Endpoint'])
    );
  });

  const awsError = (name: string, httpStatusCode: number): Error =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

  it('caches a DEFINITIVE refusal for the run: a missing grant costs one call per type, not per resource', async () => {
    // CloudFormation's query protocol answers a missing grant with a 403.
    mockCloudFormationSend.mockRejectedValue(awsError('AccessDenied', 403));
    expect(await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster')).toBeUndefined();
    expect(await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster')).toBeUndefined();

    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('finds the status one link down the cause chain (a wrapped refusal is still definitive)', async () => {
    mockCloudFormationSend.mockRejectedValue(
      Object.assign(new Error('wrapped'), { cause: awsError('AccessDenied', 403) })
    );
    expect(await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster')).toBeUndefined();
    expect(await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster')).toBeUndefined();

    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 5xx', awsError('InternalFailure', 503)],
    ['a network error with no HTTP status', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])('does NOT cache %s: the next call retries', async (_label, error) => {
    // Every attempt fails, so any retry the helper makes is exhausted too.
    mockCloudFormationSend.mockRejectedValue(error);
    expect(await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster')).toBeUndefined();

    mockCloudFormationSend.mockReset();
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: RDS_CLUSTER_SCHEMA });
    expect(await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster')).toEqual(
      new Set(['DBClusterArn', 'Endpoint'])
    );
  });

  it('caches a SUCCESS: a second call for the same type issues no second DescribeType', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: RDS_CLUSTER_SCHEMA });

    await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster');
    await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster');

    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });
});

// The registry's own `readOnlyProperties` for `AWS::EC2::Subnet` (the
// committed fixture `tests/fixtures/cfn-schemas/AWS-EC2-Subnet.json`). It does
// NOT list `VpcId` / `CidrBlock` / `AvailabilityZone`, all of which CloudFormation
// accepts in `Fn::GetAtt` and a CDK app reads through `attrVpcId` etc.
const SUBNET_SCHEMA = JSON.stringify({
  readOnlyProperties: [
    '/properties/BlockPublicAccessStates',
    '/properties/Ipv6CidrBlocks',
    '/properties/NetworkAclAssociationId',
    '/properties/SubnetId',
  ],
});

describe('getTopLevelAttributeNames (issue #3735)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearReadOnlyPropertiesCache();
    describeTypeRetryDelays.sleep = async () => {};
  });

  afterEach(() => {
    delete describeTypeRetryDelays.sleep;
  });

  it('certifies the writable properties CloudFormation accepts in Fn::GetAtt, on top of readOnlyProperties', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: SUBNET_SCHEMA });

    const names = await getTopLevelAttributeNames('AWS::EC2::Subnet');

    // Exact set: the four read-only names PLUS the table's writable ones, and
    // nothing else (`MapPublicIpOnLaunch` is writable and NOT an attribute).
    expect(names).toEqual(
      new Set([
        'BlockPublicAccessStates',
        'Ipv6CidrBlocks',
        'NetworkAclAssociationId',
        'SubnetId',
        ...WRITABLE_GETATT_ATTRIBUTES['AWS::EC2::Subnet']!,
      ])
    );
    expect(names?.has('VpcId')).toBe(true);
    expect(names?.has('CidrBlock')).toBe(true);
    expect(names?.has('AvailabilityZone')).toBe(true);
    expect(names?.has('MapPublicIpOnLaunch')).toBe(false);
  });

  it('builds the union once: a second call for the same type returns the same set', async () => {
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: SUBNET_SCHEMA });

    const first = await getTopLevelAttributeNames('AWS::EC2::Subnet');
    expect(await getTopLevelAttributeNames('AWS::EC2::Subnet')).toBe(first);
    expect(mockCloudFormationSend).toHaveBeenCalledTimes(1);
  });

  it('stays undefined when the schema cannot be resolved, rather than certifying the table names alone', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));

    expect(await getTopLevelAttributeNames('AWS::EC2::Subnet')).toBeUndefined();
  });

  it('returns the read-only set itself for a type with no table entry', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: RDS_CLUSTER_SCHEMA });
    const type = 'AWS::Pinpoint::APNSChannel';
    expect(Object.hasOwn(WRITABLE_GETATT_ATTRIBUTES, type)).toBe(false);

    const readOnly = await getTopLevelReadOnlyProperties(type);
    expect(await getTopLevelAttributeNames(type)).toBe(readOnly);
  });

  it('does not read an inherited Object.prototype key as a table entry', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: RDS_CLUSTER_SCHEMA });

    // `constructor` is not a resource type; a plain `TABLE[type]` read would
    // hand back a function and the union would throw on spreading it.
    expect(await getTopLevelAttributeNames('constructor')).toEqual(
      new Set(['DBClusterArn', 'Endpoint'])
    );
  });
});

describe('getTopLevelDeployAttributeNames (issue #2925)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudFormationSend.mockReset();
    clearReadOnlyPropertiesCache();
    describeTypeRetryDelays.sleep = async () => {};
  });

  afterEach(() => {
    delete describeTypeRetryDelays.sleep;
  });

  it('adds the shape-mismatched writable attributes the import leaves out', async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ readOnlyProperties: ['/properties/Endpoint'] }),
    });

    // `Port` is a CloudFormation attribute whose shape differs from the
    // property's: the import masks it, the deploy keeps it (CDK's
    // `allowDefaultPortFrom` reads it).
    expect((await getTopLevelAttributeNames('AWS::DocDB::DBCluster'))?.has('Port')).toBe(false);
    expect((await getTopLevelDeployAttributeNames('AWS::DocDB::DBCluster'))?.has('Port')).toBe(
      true
    );
  });

  it('stays undefined when the schema cannot be resolved', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));

    expect(await getTopLevelDeployAttributeNames('AWS::DocDB::DBCluster')).toBeUndefined();
  });
});
