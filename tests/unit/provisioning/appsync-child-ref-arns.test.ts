import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-appsync', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-appsync')>(
    '@aws-sdk/client-appsync'
  );
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

// Same shape the CloudControlProvider suites use — the provider's ARN
// reconstruction goes through the shared STS-backed resolver, and a unit test
// must not reach STS. Hoisted so individual tests can make it REJECT (the
// ARN-build-failure cases below) or return a different REGION (the partition
// cases); a `vi.mock` factory cannot close over an ordinary outer binding.
const { mockGetAccountInfo } = vi.hoisted(() => ({
  mockGetAccountInfo: vi.fn(),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: mockGetAccountInfo,
}));

// `vi.hoisted` so the tests can ASSERT on the child logger: a `const` declared
// inside the mock factory is factory-scoped and invisible at module scope, and
// a factory cannot close over an ordinary outer binding (the factory is hoisted
// above it). The import-degradation arms below assert their warnings.
const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';

/**
 * Issue #1681 — the ARN attribute each AppSync child records.
 *
 * CloudFormation's `Ref` for `AWS::AppSync::{ApiKey,DataSource,Resolver}`
 * returns the resource ARN, and `Fn::GetAtt` serves the same value; because
 * `AppSyncProvider.getAttribute` always resolves `undefined`, the attribute
 * recorded here is the ONLY source for BOTH intrinsics. Until #1681 all three
 * were string-built as `arn:aws:appsync:*:*:...` — literal `*` in the region
 * and account positions — so every consumer of either intrinsic received an
 * ARN AWS cannot resolve.
 *
 * The assertions are on the RECORDED VALUE rather than on which SDK call was
 * made: a placeholder ARN is produced by exactly the same call sequence as a
 * real one, so only the value distinguishes the fix from the bug.
 */
describe('AppSyncProvider records real ARNs for the child types (issue #1681)', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    provider = new AppSyncProvider();
    mockSend.mockReset();
    mockGetAccountInfo.mockReset();
    childLogger.warn.mockClear();
    mockGetAccountInfo.mockResolvedValue({
      partition: 'aws',
      region: 'us-east-1',
      accountId: '123456789012',
    });
  });

  it('DataSource records the ARN CreateDataSource reported', async () => {
    const reported =
      'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/datasources/myDataSource';
    mockSend.mockResolvedValue({ dataSource: { dataSourceArn: reported } });

    const result = await provider.create('DS', 'AWS::AppSync::DataSource', {
      ApiId: 'abcd1234',
      Name: 'myDataSource',
      Type: 'NONE',
    });

    expect(result.physicalId).toBe('abcd1234|myDataSource');
    expect(result.attributes?.['DataSourceArn']).toBe(reported);
  });

  it('Resolver records the ARN CreateResolver reported', async () => {
    const reported =
      'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/types/Query/resolvers/getItem';
    mockSend.mockResolvedValue({ resolver: { resolverArn: reported } });

    const result = await provider.create('R', 'AWS::AppSync::Resolver', {
      ApiId: 'abcd1234',
      TypeName: 'Query',
      FieldName: 'getItem',
    });

    expect(result.physicalId).toBe('abcd1234|Query|getItem');
    expect(result.attributes?.['ResolverArn']).toBe(reported);
  });

  // The fallback exists because a response is typed `dataSourceArn?: string`.
  // It must still produce a REAL ARN, not the pre-#1681 placeholder — this is
  // the arm a regression would most plausibly reintroduce `*:*` into.
  it.each([
    [
      'AWS::AppSync::DataSource',
      { ApiId: 'abcd1234', Name: 'myDataSource', Type: 'NONE' },
      {},
      'DataSourceArn',
      'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/datasources/myDataSource',
    ],
    [
      'AWS::AppSync::Resolver',
      { ApiId: 'abcd1234', TypeName: 'Query', FieldName: 'getItem' },
      {},
      'ResolverArn',
      'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/types/Query/resolvers/getItem',
    ],
  ])(
    '%s reconstructs a real ARN when the create response carries none',
    async (resourceType, properties, response, attributeKey, expected) => {
      mockSend.mockResolvedValue(response);

      const result = await provider.create('X', resourceType, properties);

      expect(result.attributes?.[attributeKey]).toBe(expected);
    }
  );

  // `CreateApiKey` reports no ARN field at all, so this one is always
  // reconstructed. Two things are asserted at once: the real account / region,
  // and the SINGULAR `apikey` segment — the documented form
  // (`arn:aws:appsync:us-east-1:123456789012:apis/graphqlapiid/apikey/apikeya1bzhi`,
  // read 2026-08-12). cdkd wrote the plural `apikeys` before #1681.
  it('ApiKey reconstructs the ARN with the singular apikey segment', async () => {
    mockSend.mockResolvedValue({ apiKey: { id: 'da2-abcdefghij' } });

    const result = await provider.create('K', 'AWS::AppSync::ApiKey', { ApiId: 'abcd1234' });

    expect(result.physicalId).toBe('abcd1234|da2-abcdefghij');
    expect(result.attributes?.['Arn']).toBe(
      'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/apikey/da2-abcdefghij'
    );
    expect(result.attributes?.['ApiKey']).toBe('da2-abcdefghij');
  });

  // The healing path. A resource created by a pre-#1681 binary keeps its
  // placeholder ARN forever unless `update()` reports the corrected set —
  // `create()` only re-runs on a REPLACEMENT, and the deploy engine carries the
  // existing attributes forward when a provider reports none.
  it.each([
    [
      'AWS::AppSync::DataSource',
      'abcd1234|myDataSource',
      { Name: 'myDataSource', Description: 'changed' },
      {
        DataSourceArn:
          'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/datasources/myDataSource',
        Name: 'myDataSource',
      },
    ],
    [
      'AWS::AppSync::Resolver',
      'abcd1234|Query|getItem',
      { DataSourceName: 'changed' },
      {
        ResolverArn:
          'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/types/Query/resolvers/getItem',
      },
    ],
    [
      'AWS::AppSync::ApiKey',
      'abcd1234|da2-abcdefghij',
      { Description: 'changed' },
      {
        ApiKey: 'da2-abcdefghij',
        Arn: 'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/apikey/da2-abcdefghij',
      },
    ],
  ])(
    'update of %s reports the healed attribute set',
    async (resourceType, physicalId, properties, expected) => {
      mockSend.mockResolvedValue({});

      const result = await provider.update('X', physicalId, resourceType, properties, {});

      // The engine REPLACES the record's map with this one rather than merging,
      // so a partial answer would silently drop the non-ARN keys.
      expect(result.attributes).toEqual(expected);
    }
  );

  // A record too malformed to rebuild from must report NO attributes, so the
  // engine carries the existing ones forward instead of a guessed set.
  // All three types, not just Resolver: a 4-part id also clears
  // `updateDataSource`'s and `updateApiKey`'s own truthiness guards, so each
  // reaches the same `return undefined` arm by its own route.
  it.each([
    ['AWS::AppSync::Resolver', 'abcd1234|a|b|c', { DataSourceName: 'changed' }],
    ['AWS::AppSync::DataSource', 'abcd1234|a|b|c', { Name: 'a', Description: 'changed' }],
    ['AWS::AppSync::ApiKey', 'abcd1234|a|b|c', { Description: 'changed' }],
  ])('update of a mis-arity %s id reports no attributes', async (resourceType, id, props) => {
    mockSend.mockResolvedValue({});

    const result = await provider.update('X', id, resourceType, props, {});

    expect(result.attributes).toBeUndefined();
  });

  // Issue #1710 class, settled by the PR review. An earlier cut asserted only
  // that the failure was not MIS-LABELLED as a create failure — but the review
  // pointed out that placement alone does not stop the orphan: `create()` still
  // threw, and a failed CREATE journals no physicalId, so the rollback executor
  // skips it and the resource sits in AWS untracked. That assertion is therefore
  // superseded by this stronger one: the create must SUCCEED.
  //
  // PR-review finding: moving the ARN build outside the create `try` stops the
  // failure being MIS-LABELLED, but on its own it does not stop the orphan —
  // `create()` still throws, and a failed CREATE journals no physicalId. The
  // resource is already real, so the ARN (bookkeeping) must never fail the
  // create: warn, omit, and let the next update heal it.
  it.each([
    [
      'AWS::AppSync::DataSource',
      { ApiId: 'a', Name: 'ds', Type: 'NONE' },
      {},
      'abcd1234|ds',
      'DataSourceArn',
      'Name',
    ],
    [
      'AWS::AppSync::Resolver',
      { ApiId: 'a', TypeName: 'Query', FieldName: 'f' },
      {},
      'a|Query|f',
      'ResolverArn',
      undefined,
    ],
    [
      'AWS::AppSync::ApiKey',
      { ApiId: 'a' },
      { apiKey: { id: 'da2-k' } },
      'a|da2-k',
      'Arn',
      'ApiKey',
    ],
  ])(
    'create of %s SUCCEEDS with the ARN omitted when the ARN build fails',
    async (resourceType, properties, response, _id, arnKey, survivingKey) => {
      mockSend.mockResolvedValue(response);
      mockGetAccountInfo.mockRejectedValue(new Error('sts exploded'));

      const result = await provider.create('X', resourceType, properties);

      // The create must NOT fail — that is the whole point.
      expect(result.physicalId).toBeTruthy();
      // ...and the unusable attribute is OMITTED, not recorded as undefined:
      // a present-but-undefined key survives a structuredClone into state and
      // would be read back as a declared-but-empty attribute.
      expect(Object.hasOwn(result.attributes ?? {}, arnKey)).toBe(false);
      if (survivingKey) {
        expect(result.attributes?.[survivingKey]).toBeDefined();
      }
    }
  );

  // The PARTITION must come from the REGION, not from `getAccountInfo`'s
  // hardcoded `'aws'`. This matters most on the UPDATE path, which rebuilds the
  // ARN every time: without it a correct `arn:aws-cn:` recorded at create time
  // would be overwritten with `arn:aws:` on the next in-place update.
  it.each([
    ['cn-north-1', 'aws-cn'],
    ['us-gov-west-1', 'aws-us-gov'],
    ['us-east-1', 'aws'],
  ])('rebuilds the ARN with the partition implied by region %s', async (region, partition) => {
    mockGetAccountInfo.mockResolvedValue({
      partition: 'aws', // deliberately the hardcoded value — must NOT be used
      region,
      accountId: '123456789012',
    });
    mockSend.mockResolvedValue({});

    const result = await provider.update(
      'X',
      'abcd1234|myDataSource',
      'AWS::AppSync::DataSource',
      { Name: 'myDataSource', Description: 'changed' },
      {}
    );

    expect(result.attributes?.['DataSourceArn']).toBe(
      `arn:${partition}:appsync:${region}:123456789012:apis/abcd1234/datasources/myDataSource`
    );
  });

  // Whole-class fence: no recorded attribute may carry the wildcard positions
  // again, whichever arm produced it.
  it('no child type records a wildcard-bearing ARN', async () => {
    const cases: Array<[string, Record<string, unknown>, unknown]> = [
      [
        'AWS::AppSync::DataSource',
        { ApiId: 'abcd1234', Name: 'myDataSource', Type: 'NONE' },
        { dataSource: {} },
      ],
      [
        'AWS::AppSync::Resolver',
        { ApiId: 'abcd1234', TypeName: 'Query', FieldName: 'getItem' },
        { resolver: {} },
      ],
      ['AWS::AppSync::ApiKey', { ApiId: 'abcd1234' }, { apiKey: { id: 'da2-abcdefghij' } }],
    ];

    for (const [resourceType, properties, response] of cases) {
      mockSend.mockReset();
      mockSend.mockResolvedValue(response);

      const result = await provider.create('X', resourceType, properties);

      const arnValues = Object.entries(result.attributes ?? {}).filter(
        ([, value]) => typeof value === 'string' && value.startsWith('arn:')
      );
      // FLOOR, so the fence cannot go dark: the wildcard check below lives
      // inside a loop over ARN-valued attributes, so a regression that DROPPED
      // or RENAMED the ARN attribute would run zero iterations and pass green —
      // the fence would silently stop fencing exactly when it matters.
      expect(arnValues.length).toBeGreaterThanOrEqual(1);
      for (const [key, value] of arnValues) {
        expect(`${resourceType}.${key}=${String(value)}`).not.toContain(':*:');
      }
    }
  });

  // The REGION must reach the ARN builder. `getAccountInfo(overrideRegion)`
  // returns `overrideRegion || AWS_REGION || 'us-east-1'`, and the mock here
  // answers `us-east-1` whatever it is passed — so without this assertion a
  // regression that dropped the argument would record a us-east-1 ARN for a
  // eu-west-1 deploy and every other test would still pass.
  it('threads the provider region into the ARN builder', async () => {
    mockSend.mockResolvedValue({ apiKey: { id: 'da2-abcdefghij' } });

    await provider.create('K', 'AWS::AppSync::ApiKey', { ApiId: 'abcd1234' });

    expect(mockGetAccountInfo).toHaveBeenCalledWith('us-east-1');
  });
});

/**
 * Issue #1728 — the residual #1681 left: `import()` recorded `attributes: {}`
 * for every child type, so an ADOPTED child had no ARN in state, the resolver's
 * `REF_RETURNS_ARN_FROM_STATE` lookup missed, and `Ref` fell back to the raw
 * compound id (the pre-#1681 behavior) until the resource's next update.
 *
 * Asserted on the RECORDED VALUE for the same reason the #1681 block above is:
 * the call sequence is identical whether the attribute is recorded or not.
 */
describe('AppSyncProvider.import records the child ARN attributes (issue #1728)', () => {
  let provider: AppSyncProvider;

  const importInput = (resourceType: string, knownPhysicalId?: string) => ({
    logicalId: 'X',
    resourceType,
    stackName: 'MyStack',
    region: 'us-east-1',
    properties: {},
    ...(knownPhysicalId !== undefined && { knownPhysicalId }),
  });

  beforeEach(() => {
    provider = new AppSyncProvider();
    mockSend.mockReset();
    mockGetAccountInfo.mockReset();
    childLogger.warn.mockClear();
    mockGetAccountInfo.mockResolvedValue({
      partition: 'aws',
      region: 'us-east-1',
      accountId: '123456789012',
    });
  });

  // The complete set, not just the ARN: `import` writes the record's attribute
  // map outright, so a partial answer would leave `Name` / `ApiKey` unresolvable
  // for an adopted resource exactly as the ARN was.
  it.each([
    [
      'AWS::AppSync::DataSource',
      'abcd1234|myDataSource',
      {
        DataSourceArn:
          'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/datasources/myDataSource',
        Name: 'myDataSource',
      },
    ],
    [
      'AWS::AppSync::Resolver',
      'abcd1234|Query|getItem',
      {
        ResolverArn:
          'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/types/Query/resolvers/getItem',
      },
    ],
    [
      'AWS::AppSync::ApiKey',
      'abcd1234|da2-abcdefghij',
      {
        ApiKey: 'da2-abcdefghij',
        Arn: 'arn:aws:appsync:us-east-1:123456789012:apis/abcd1234/apikey/da2-abcdefghij',
      },
    ],
  ])('import of %s records the same attribute set create() does', async (type, id, expected) => {
    const result = await provider.import(importInput(type, id));

    expect(result).toEqual({ physicalId: id, attributes: expected });
    // The reconstruction must cost no AppSync API call — that is the whole
    // reason it is preferred over a readback per imported child.
    expect(mockSend).not.toHaveBeenCalled();
  });

  // The recorded value must be usable, not merely present: the pre-#1681
  // spelling would satisfy a "records an ARN" assertion while being exactly the
  // value the resolver refuses.
  //
  // Asserted as a PREFIX rather than as `not.toContain(':*:')` (review
  // finding): the negative form passes with the whole fix reverted, because
  // `String(undefined)` is `'undefined'`, which contains no `:*:` either — an
  // absence would have satisfied the fence it exists to be.
  it('records a real, non-wildcard ARN for an imported child', async () => {
    const result = await provider.import(
      importInput('AWS::AppSync::DataSource', 'abcd1234|myDataSource')
    );

    const arn = result?.attributes?.['DataSourceArn'];
    expect(typeof arn).toBe('string');
    expect(arn as string).toMatch(/^arn:aws:appsync:us-east-1:123456789012:/);
    expect(arn as string).not.toContain(':*:');
  });

  // Degradation arms — each must keep the pre-#1728 answer rather than guess.
  it.each([
    // A mis-arity id: `childRefAttributes` answers `undefined`.
    ['AWS::AppSync::Resolver', 'abcd1234|a|b|c'],
    // A type with no ARN-`Ref` mapping at all.
    ['AWS::AppSync::GraphQLSchema', 'abcd1234'],
  ])('import of %s still adopts with an empty attribute map', async (type, id) => {
    const result = await provider.import(importInput(type, id));

    expect(result).toEqual({ physicalId: id, attributes: {} });
  });

  // Adoption is worth more than the bookkeeping attribute: a failure must warn
  // and degrade, never fail the import.
  it('import SUCCEEDS with an empty attribute map when the ARN build throws', async () => {
    mockGetAccountInfo.mockRejectedValue(new Error('sts exploded'));

    const result = await provider.import(
      importInput('AWS::AppSync::DataSource', 'abcd1234|myDataSource')
    );

    expect(result).toEqual({ physicalId: 'abcd1234|myDataSource', attributes: {} });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not build its ARN attribute')
    );
  });

  // THE arm that matters, and the one a `try` alone does not cover (review
  // finding). The real `getAccountInfo` CATCHES its own STS failure and returns
  // the hardcoded `123456789012` with `fabricated: true` — it does NOT reject —
  // so the test above pins a path production cannot reach on an STS outage.
  //
  // A fabricated ARN carries no wildcard, so `isPlaceholderArn` can never catch
  // it downstream: recording it would hand every later `Ref` / `Fn::GetAtt` a
  // confidently-wrong ARN. Recording NOTHING is the honest answer.
  it('import records NO ARN when STS was unreachable and the account is fabricated', async () => {
    mockGetAccountInfo.mockResolvedValue({
      accountId: '123456789012',
      region: 'us-east-1',
      partition: 'aws',
      fabricated: true,
    });

    const result = await provider.import(
      importInput('AWS::AppSync::DataSource', 'abcd1234|myDataSource')
    );

    expect(result).toEqual({ physicalId: 'abcd1234|myDataSource', attributes: {} });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not determine the AWS account')
    );
  });

  // The ARN must name the region the STATE RECORD is keyed by, which `import`
  // resolves itself — not the region the provider's client happens to hold.
  it('builds the ARN from the import input region, not the client region', async () => {
    mockGetAccountInfo.mockImplementation((region?: string) =>
      Promise.resolve({ accountId: '123456789012', region: region ?? 'us-east-1', partition: 'aws' })
    );

    const result = await provider.import({
      ...importInput('AWS::AppSync::DataSource', 'abcd1234|myDataSource'),
      region: 'eu-west-1',
    });

    expect(mockGetAccountInfo).toHaveBeenCalledWith('eu-west-1');
    expect(result?.attributes?.['DataSourceArn']).toBe(
      'arn:aws:appsync:eu-west-1:123456789012:apis/abcd1234/datasources/myDataSource'
    );
  });

  // Unchanged by #1728: with no caller-supplied id there is nothing to adopt,
  // and the child types are explicit-override only.
  it('import of a child with no known physical id still returns null', async () => {
    expect(await provider.import(importInput('AWS::AppSync::DataSource'))).toBeNull();
  });
});
