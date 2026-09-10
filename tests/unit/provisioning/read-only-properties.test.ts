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
  getTopLevelReadOnlyProperties,
  clearReadOnlyPropertiesCache,
} from '../../../src/provisioning/read-only-properties.js';
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

  it('does NOT cache a failure: a later call retries and can succeed', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    expect(await getTopLevelReadOnlyProperties('AWS::RDS::DBCluster')).toBeUndefined();

    mockCloudFormationSend.mockReset();
    mockCloudFormationSend.mockResolvedValueOnce({ Schema: RDS_CLUSTER_SCHEMA });

    // A cached failure would keep answering `undefined` here, which for the
    // caller means "mask everything" forever after one transient throttle.
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
