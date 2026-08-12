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
// must not reach STS. Hoisted so individual tests can make it REJECT (see the
// issue #1710 placement test at the bottom); a `vi.mock` factory cannot close
// over an ordinary outer binding.
const { mockGetAccountInfo } = vi.hoisted(() => ({
  mockGetAccountInfo: vi.fn(),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: mockGetAccountInfo,
}));

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
  it('update of a mis-arity child id reports no attributes', async () => {
    mockSend.mockResolvedValue({});

    const result = await provider.update(
      'X',
      'abcd1234|a|b|c',
      'AWS::AppSync::Resolver',
      { DataSourceName: 'changed' },
      {}
    );

    expect(result.attributes).toBeUndefined();
  });

  // Issue #1710 class: `buildAppSyncArn` is async (it can reach STS), so it
  // must run OUTSIDE the try that wraps the create call. A throw after a
  // successful AWS mutation would be re-wrapped as
  // `ProvisioningError('Failed to create …')` — and the deploy engine journals
  // no physicalId for a FAILED create, so the rollback executor skips the op
  // and the resource is left in AWS, invisible to state.
  //
  // Asserting on the error's SHAPE is what pins the placement: with the ARN
  // build inside the try, the raw failure is swallowed and re-thrown with the
  // create wrapper's message, which is the exact mislabel this guards.
  it.each([
    ['AWS::AppSync::DataSource', { ApiId: 'a', Name: 'ds', Type: 'NONE' }, {}, 'DataSource'],
    [
      'AWS::AppSync::Resolver',
      { ApiId: 'a', TypeName: 'Query', FieldName: 'f' },
      {},
      'Resolver',
    ],
  ])(
    'an ARN-build failure on %s is not mislabelled as a create failure',
    async (resourceType, properties, response, label) => {
      mockSend.mockResolvedValue(response);
      mockGetAccountInfo.mockRejectedValue(new Error('sts exploded'));

      await expect(provider.create('X', resourceType, properties)).rejects.toThrow('sts exploded');
      // The create DID succeed — the failure must not claim otherwise.
      await expect(provider.create('X', resourceType, properties)).rejects.not.toThrow(
        `Failed to create ${label}`
      );
      expect(mockSend).toHaveBeenCalled();
    }
  );

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

      for (const [key, value] of Object.entries(result.attributes ?? {})) {
        if (typeof value === 'string' && value.startsWith('arn:')) {
          expect(`${resourceType}.${key}=${value}`).not.toContain(':*:');
        }
      }
    }
  });
});
